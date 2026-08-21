import { join, extname, resolve } from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";
import { dataDir } from "../config.js";
import { getPublisher } from "./publishers/factory.js";
import { DouyinPublisher } from "./publishers/douyin-publisher.js";
import { XiaohongshuPublisher } from "./publishers/xiaohongshu-publisher.js";
import { ChannelsPublisher } from "./publishers/channels-publisher.js";
import { ZhihuPublisher } from "./publishers/zhihu-publisher.js";
import { ZhihuVideoPublisher } from "./publishers/zhihu-video-publisher.js";
import { generateFallbackPackage } from "./publishers/fallback-export.js";
import * as recordsRepo from "../db/publish-records-repo.js";
import { getAccount, listAccountsByPlatform } from "../db/accounts-repo.js";
import { getDb } from "../db/connection.js";
import { updateWork, getWork } from "../db/works-repo.js";
import { listArticlesByWork } from "../db/articles-repo.js";
import type { Publisher, PublishInput, PublishOutput } from "./publishers/types.js";
import type { DbWork } from "../db/types.js";

export { type PublishInput, type PublishOutput } from "./publishers/types.js";

/* ── PublishRecord 接口 ── */
export interface PublishRecord {
  id: number;
  workId: string;
  platform: string;
  status: "pending" | "publishing" | "published" | "failed" | "scheduled" | "fallback";
  platformPostId?: string;
  postUrl?: string;
  error?: string;
  publishedAt?: string;
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function toPublishRecord(row: ReturnType<typeof recordsRepo.getPublishRecord>): PublishRecord {
  if (!row) throw new Error("Cannot convert null record");
  const metadataParsed: Record<string, unknown> = (() => {
    try {
      return typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  return {
    id: row.id,
    workId: row.work_id,
    platform: row.platform,
    status: row.status as PublishRecord["status"],
    platformPostId: row.platform_post_id,
    postUrl: metadataParsed.postUrl as string | undefined,
    error: row.error_message,
    publishedAt: row.published_at,
    scheduledAt: row.scheduled_at,
    metadata: metadataParsed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const publisherCache = new Map<string, Publisher>();

/** 前端/账号体系使用的平台键 → 发布器注册键（wechat_mp 是 UI 侧键，发布器注册为 wechat） */
const PLATFORM_ALIASES: Record<string, string> = {
  wechat_mp: "wechat",
};

export function resolvePublisher(platform: string): Publisher {
  const key = PLATFORM_ALIASES[platform] ?? platform;
  if (!publisherCache.has(key)) {
    if (key === "douyin") publisherCache.set(key, new DouyinPublisher());
    else if (key === "xiaohongshu") publisherCache.set(key, new XiaohongshuPublisher());
    else if (key === "channels") publisherCache.set(key, new ChannelsPublisher());
    else if (key === "zhihu") publisherCache.set(key, new ZhihuPublisher());
    else publisherCache.set(key, getPublisher(key));
  }
  return publisherCache.get(key)!;
}

const FALLBACK_PLATFORMS = ["douyin", "xiaohongshu", "channels"];

let zhihuVideoPublisher: Publisher | null = null;

/**
 * 按「作品类型」分发发布器(2026-08-07 视频/图文分块约定):
 * 知乎 short-video 作品 → 视频发布器(upload-video 页);
 * 知乎 image-text 作品 → 文章发布器(写专栏)。其余平台不分类型。
 */
function resolvePublisherForWork(platform: string, workType?: string): Publisher {
  const key = PLATFORM_ALIASES[platform] ?? platform;
  if (key === "zhihu" && workType !== "image-text") {
    if (!zhihuVideoPublisher) zhihuVideoPublisher = new ZhihuVideoPublisher();
    return zhihuVideoPublisher;
  }
  return resolvePublisher(platform);
}

/** 解析发布目标账号:显式 > 平台默认 > undefined(走旧凭证兜底)。显式值非法直接抛错。 */
export function resolvePublishAccountId(platform: string, accountId?: string): string | undefined {
  if (accountId) {
    const account = getAccount(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    if (account.platform !== platform) throw new Error(`账号 ${accountId} 不属于平台 ${platform}`);
    return accountId;
  }
  const def = listAccountsByPlatform(platform).find((a) => a.is_default === 1);
  return def?.id;
}

export async function publishToPlatform(workId: string, platform: string, input: PublishInput): Promise<PublishRecord> {
  const accountId = resolvePublishAccountId(platform, input.accountId);
  // 去重键 (work_id, platform, account_id):account_id 的 null 与 undefined 视为同值
  const existing = recordsRepo.listPublishRecords({ workId }).find(
    (r) => r.platform === platform && r.status !== "failed" && (r.account_id ?? null) === (accountId ?? null)
  );
  let recordId: number;
  if (existing) {
    recordId = existing.id;
    recordsRepo.updatePublishRecord(recordId, { status: "publishing" });
  } else {
    const created = recordsRepo.createPublishRecord({
      work_id: workId,
      platform,
      account_id: accountId,
      status: "publishing",
      metadata: "",
    });
    recordId = created.id;
  }

  const work = getWork(workId);
  const publisher = resolvePublisherForWork(platform, work?.type);
  let result: PublishOutput;
  try {
    // 发布外层超时护栏(2026-08-19 P2):Playwright 流程正常 5-8 分钟,给 10 分钟;
    // 无护栏时挂死的请求会让发布路由永不返回(前端按钮永远"发布中")
    result = await Promise.race([
      publisher.publish({ ...input, accountId }),
      new Promise<PublishOutput>((_, rej) => setTimeout(() => rej(new Error("发布超时(10min)")), 10 * 60_000)),
    ]);
  } catch (err) {
    result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.success) {
    // 2026-08-19 P2:审核中不再当"已发布"——reviewing 态等对账任务确认,
    // published_at 从过审时刻起算(此前从提交时刻起算,审核耗时吃掉 48h 回流窗口)
    const reviewing = result.reviewing === true;
    recordsRepo.updatePublishRecord(recordId, {
      status: reviewing ? "reviewing" : "published",
      platform_post_id: result.platformPostId ?? undefined,
      // 清掉上次失败的错误文本,避免"published 但带错误信息"的困惑(2026-08-07 实测)
      error_message: null as unknown as undefined,
      metadata: JSON.stringify({ postUrl: result.postUrl }),
      published_at: reviewing ? undefined : new Date().toISOString(),
    });
    if (!reviewing) await updateWork(workId, { status: "published" });
  } else if (FALLBACK_PLATFORMS.includes(platform)) {
    const packagePath = await generateFallbackPackage(platform, input, join(dataDir, "fallback-packages"));
    recordsRepo.updatePublishRecord(recordId, {
      status: "fallback",
      error_message: result.error ?? undefined,
      metadata: JSON.stringify({ fallbackPackagePath: packagePath }),
    });
  } else {
    recordsRepo.updatePublishRecord(recordId, {
      status: "failed",
      error_message: result.error ?? undefined,
    });
  }

  const updated = recordsRepo.getPublishRecord(recordId);
  if (!updated) throw new Error("Failed to get updated publish record");
  return toPublishRecord(updated);
}

export async function getPublishingStatus(workId: string): Promise<PublishRecord[]> {
  const records = recordsRepo.listPublishRecords({ workId });
  return records.map((r) => toPublishRecord(r));
}

/** 正文配图支持的图片扩展名 */
const CONTENT_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * 收集作品素材图（公众号/知乎正文插图用）：
 * 扫描 works/<id>/assets/images/ 与 works/<id>/output/ 下的图片，排除封面，按路径排序。
 */
async function collectContentImages(workDir: string, coverPath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在（如纯文本作品没有 assets/images）
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (CONTENT_IMAGE_EXTS.has(extname(entry.name).toLowerCase())) results.push(full);
    }
  }
  await walk(join(workDir, "assets", "images"));
  await walk(join(workDir, "output"));
  const coverResolved = resolve(coverPath);
  return results.filter((p) => resolve(p) !== coverResolved).sort();
}

/**
 * 收集双产物派生的小红书图片卡片（works/<id>/output/cards/ 下的 PNG）。
 * 文件名 01-cover.png / 02-card.png … 字典序即展示顺序，封面在最前。
 */
async function collectCardImages(outputDir: string): Promise<string[]> {
  const cardsDir = join(outputDir, "cards");
  let entries;
  try {
    entries = await readdir(cardsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && CONTENT_IMAGE_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(cardsDir, e.name))
    .sort();
}

export async function triggerLogin(platform: string): Promise<boolean> {
  const publisher = resolvePublisher(platform);
  if (publisher.login) return publisher.login();
  throw new Error(`平台 ${platform} 不支持浏览器登录`);
}

/**
 * publish_records 卡死恢复(2026-08-19 P2,收敛评估第 1 条):
 * 服务崩溃/断电会让记录永久停在 publishing(看板永远"发布中"),且重试会复用
 * 卡死记录(existing.status!=="failed" 语义混乱)。启动时把 10 分钟前的
 * publishing 一律置 failed——10 分钟门槛避免误杀刚入队的正常任务。
 */
export function recoverStuckPublishRecords(stuckMs = 10 * 60_000): number {
  const cutoff = new Date(Date.now() - stuckMs).toISOString();
  const r = getDb()
    .prepare(`UPDATE publish_records SET status='failed', error_message='服务重启时发布中断(卡死恢复)', updated_at=datetime('now') WHERE status='publishing' AND updated_at < ?`)
    .run(cutoff);
  if (r.changes > 0) console.log(`[publishing] 卡死恢复:${r.changes} 条 publishing → failed`);
  return r.changes;
}

export async function buildPublishInput(work: DbWork, platform: string): Promise<PublishInput> {
  const workDir = join(dataDir, "works", work.id);
  const outputDir = join(workDir, "output");

  let videoPath = join(outputDir, "final.mp4");
  try {
    await stat(videoPath);
  } catch {
    const altPath = join(outputDir, "video.mp4");
    try {
      await stat(altPath);
      videoPath = altPath;
    } catch {
      // will be handled by caller
    }
  }

  const coverPath = join(outputDir, "cover.jpg");
  const options: Record<string, unknown> = {};
  let title = work.title;

  // 发布文案消费(2026-08-19 P0):publish-text.md 是 A1 门禁强制产出物,但此前
  // 没有任何消费者——一键发布发出去的是作品标题+文章截断,爆款文案白写。
  // 现在:标题/正文/标签优先取自该文件;平台特化配文(如小红书 caption.txt)优先于正文。
  try {
    const md = await readFile(join(outputDir, "publish-text.md"), "utf-8");
    const pt = parsePublishText(md);
    if (pt.title) title = pt.title;
    if (pt.body) options.description = pt.body;
    if (pt.tags?.length) options.tags = pt.tags;
  } catch { /* 无文案文件,回落作品标题 */ }

  // 文章注入按「作品类型 × 平台」分块(2026-08-07 视频/图文分块约定):
  // - 公众号:图文-only 平台,任何作品类型都发文章;
  // - 知乎:image-text 作品发专栏文章;short-video 作品走视频发布器(不注入文章);
  //   —— 此前不区分,视频发布页点知乎发出去的是文章(实测"河北中考体育50分")。
  const key = PLATFORM_ALIASES[platform] ?? platform;
  const isImageTextWork = work.type === "image-text";
  if (key === "wechat" || (key === "zhihu" && isImageTextWork)) {
    const article = listArticlesByWork(work.id)[0];
    if (article?.content) {
      options.content = article.content;
      options.articleTitle = article.title;
    }
    // 正文配图：作品素材图（排除封面），发布器按段落插图；无图时为空数组，维持纯文本
    options.contentImages = await collectContentImages(workDir, coverPath);
  }

  // 小红书图文卡片:仅 image-text 作品(图文子作品/纯图文作品)走图文笔记链路;
  // short-video 作品即使在 output/cards 有遗留卡片也只能发视频 ——
  // 视频发布页小红书必须发视频(2026-08-07 分块约定)。
  if (key === "xiaohongshu" && isImageTextWork) {
    const cards = await collectCardImages(outputDir);
    if (cards.length > 0) {
      options.imagePaths = cards;
      // 配文优先读派生时生成的 caption.txt(LLM 提炼,≤1000 字);
      // 没有则句边界智能截断 —— 不再 slice(0,1000) 断在半句(2026-08-07 实证)
      const { generateXhsCaption, smartTruncate } = await import("./dual-output.js");
      let caption: string | undefined;
      try {
        caption = (await readFile(join(outputDir, "cards", "caption.txt"), "utf-8")).trim() || undefined;
      } catch { /* 无 caption 文件 */ }
      const article = listArticlesByWork(work.id)[0];
      if (!caption && article?.content) {
        caption = smartTruncate(article.content);
      }
      if (caption) options.description = caption;
    }
  }

  return {
    workId: work.id,
    videoPath,
    coverPath,
    title,
    options,
  };
}

/**
 * 解析 output/publish-text.md(2026-08-19 统一发布文案文件名,取代 copytext.md)。
 * 约定结构(assembly 阶段提示词同步):首个非空行=发布标题(钩子),
 * 中段=正文,最后一个 # 开头的行=话题标签。
 */
export function parsePublishText(md: string): { title?: string; body?: string; tags?: string[] } {
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return {};
  const tagLine = [...lines].reverse().find((l) => l.startsWith("#"));
  const tags = tagLine ? (tagLine.match(/#([^\s#]+)/g) ?? []).map((t) => t.slice(1)) : undefined;
  const bodyLines = lines.filter((l) => l !== tagLine);
  return {
    title: bodyLines[0],
    body: bodyLines.length > 1 ? bodyLines.slice(1).join("\n") : undefined,
    tags: tags?.length ? tags : undefined,
  };
}
