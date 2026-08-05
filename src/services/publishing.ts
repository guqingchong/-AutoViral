import { join } from "node:path";
import { stat } from "node:fs/promises";
import { dataDir } from "../config.js";
import { getPublisher } from "./publishers/factory.js";
import { DouyinPublisher } from "./publishers/douyin-publisher.js";
import { XiaohongshuPublisher } from "./publishers/xiaohongshu-publisher.js";
import { ChannelsPublisher } from "./publishers/channels-publisher.js";
import { ZhihuPublisher } from "./publishers/zhihu-publisher.js";
import { generateFallbackPackage } from "./publishers/fallback-export.js";
import * as recordsRepo from "../db/publish-records-repo.js";
import { updateWork } from "../db/works-repo.js";
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

  const publisher = resolvePublisher(platform);
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

  // 文章型平台（知乎/公众号）：发布器需要 options.content 作为正文，
  // 注入该作品最新一篇文章的内容，否则发布器只能发标题占位文本
  const key = PLATFORM_ALIASES[platform] ?? platform;
  if (key === "zhihu" || key === "wechat") {
    const article = listArticlesByWork(work.id)[0];
    if (article?.content) {
      options.content = article.content;
      options.articleTitle = article.title;
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
