import { join, extname, resolve } from "node:path";
import { stat, readdir } from "node:fs/promises";
import { dataDir } from "../config.js";
import { getPublisher } from "./publishers/factory.js";
import { DouyinPublisher } from "./publishers/douyin-publisher.js";
import { XiaohongshuPublisher } from "./publishers/xiaohongshu-publisher.js";
import { ChannelsPublisher } from "./publishers/channels-publisher.js";
import { ZhihuPublisher } from "./publishers/zhihu-publisher.js";
import { ZhihuVideoPublisher } from "./publishers/zhihu-video-publisher.js";
import { generateFallbackPackage } from "./publishers/fallback-export.js";
import * as recordsRepo from "../db/publish-records-repo.js";
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

export async function publishToPlatform(workId: string, platform: string, input: PublishInput): Promise<PublishRecord> {
  const existing = recordsRepo.listPublishRecords({ workId }).find(
    (r) => r.platform === platform && r.status !== "failed"
  );
  let recordId: number;
  if (existing) {
    recordId = existing.id;
    recordsRepo.updatePublishRecord(recordId, { status: "publishing" });
  } else {
    const created = recordsRepo.createPublishRecord({
      work_id: workId,
      platform,
      status: "publishing",
      metadata: "",
    });
    recordId = created.id;
  }

  const work = getWork(workId);
  const publisher = resolvePublisherForWork(platform, work?.type);
  let result: PublishOutput;
  try {
    result = await publisher.publish(input);
  } catch (err) {
    result = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.success) {
    recordsRepo.updatePublishRecord(recordId, {
      status: "published",
      platform_post_id: result.platformPostId ?? undefined,
      metadata: JSON.stringify({ postUrl: result.postUrl }),
      published_at: new Date().toISOString(),
    });
    await updateWork(workId, { status: "published" });
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
      const article = listArticlesByWork(work.id)[0];
      if (article?.content) options.description = article.content.slice(0, 1000);
    }
  }

  return {
    workId: work.id,
    videoPath,
    coverPath,
    title: work.title,
    options,
  };
}
