import { join } from "node:path";
import { stat } from "node:fs/promises";
import { dataDir } from "../config.js";
import { getPublisher } from "./publishers/factory.js";
import { DouyinPublisher } from "./publishers/douyin-publisher.js";
import { XiaohongshuPublisher } from "./publishers/xiaohongshu-publisher.js";
import { ChannelsPublisher } from "./publishers/channels-publisher.js";
import { generateFallbackPackage } from "./publishers/fallback-export.js";
import * as recordsRepo from "../db/publish-records-repo.js";
import { updateWork } from "../db/works-repo.js";
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

export function toPublishRecord(row: Record<string, unknown> | ReturnType<typeof recordsRepo.getPublishRecord>): PublishRecord {
  if (!row) throw new Error("Cannot convert null record");
  const dbRecord = row as ReturnType<typeof recordsRepo.getPublishRecord>;
  if (!dbRecord) throw new Error("Cannot convert undefined record");
  const metadataParsed: Record<string, unknown> = (() => {
    try {
      return typeof dbRecord.metadata === "string" ? JSON.parse(dbRecord.metadata) : dbRecord.metadata as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  return {
    id: dbRecord.id,
    workId: dbRecord.work_id,
    platform: dbRecord.platform,
    status: dbRecord.status as PublishRecord["status"],
    platformPostId: dbRecord.platform_post_id,
    postUrl: metadataParsed.postUrl as string | undefined,
    error: dbRecord.error_message,
    publishedAt: dbRecord.published_at,
    scheduledAt: dbRecord.scheduled_at,
    metadata: metadataParsed,
    createdAt: dbRecord.created_at,
    updatedAt: dbRecord.updated_at,
  };
}

const publisherCache = new Map<string, Publisher>();

export function resolvePublisher(platform: string): Publisher {
  if (!publisherCache.has(platform)) {
    if (platform === "douyin") publisherCache.set(platform, new DouyinPublisher());
    else if (platform === "xiaohongshu") publisherCache.set(platform, new XiaohongshuPublisher());
    else if (platform === "channels") publisherCache.set(platform, new ChannelsPublisher());
    else publisherCache.set(platform, getPublisher(platform));
  }
  return publisherCache.get(platform)!;
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
      platform_post_id: result.platformPostId ?? null,
      metadata: JSON.stringify({ postUrl: result.postUrl }),
      published_at: new Date().toISOString(),
    });
    await updateWork(workId, { status: "published" });
  } else if (FALLBACK_PLATFORMS.includes(platform)) {
    const packagePath = await generateFallbackPackage(platform, input, join(dataDir, "fallback-packages"));
    recordsRepo.updatePublishRecord(recordId, {
      status: "fallback",
      error_message: result.error ?? null,
      metadata: JSON.stringify({ fallbackPackagePath: packagePath }),
    });
  } else {
    recordsRepo.updatePublishRecord(recordId, {
      status: "failed",
      error_message: result.error ?? null,
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
  if (platform === "douyin") return (publisher as DouyinPublisher).login();
  if (platform === "xiaohongshu") return (publisher as XiaohongshuPublisher).login();
  throw new Error(`平台 ${platform} 不支持浏览器登录`);
}

export async function buildPublishInput(work: DbWork, _platform: string): Promise<PublishInput> {
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

  return {
    workId: work.id,
    videoPath,
    coverPath,
    title: work.title,
    options: {},
  };
}
