/**
 * Phase 5 analytics collector.
 *
 * Orchestrates registered platform adapters to collect:
 * - account-level metrics
 * - post-level metrics for published works
 * - comments for published works
 *
 * This replaces the previous Python-script-based collector.
 */

import { getAdapter, listAdapters } from "./services/platform-adapters/registry.js";
import { listPublishRecords } from "./db/publish-records-repo.js";
import { createMetric, getLatestAccountMetric } from "./db/platform-metrics-repo.js";
import { createComment, listComments } from "./db/comments-repo.js";
import { classifySentiment } from "./services/sentiment-helper.js";
import type { DbPlatformMetric } from "./db/types.js";

export interface CollectorResult {
  metricsCollected: number;
  commentsCollected: number;
  accountMetricsCollected: number;
  errors: string[];
}

/**
 * Collect metrics and comments for all registered adapters, or a subset of platforms.
 * If `platforms` is omitted, every registered adapter is used.
 */
export async function collectAll(platforms?: string[]): Promise<CollectorResult> {
  const result: CollectorResult = {
    metricsCollected: 0,
    commentsCollected: 0,
    accountMetricsCollected: 0,
    errors: [],
  };

  const adapters = platforms
    ? platforms.map((p) => ({ adapter: getAdapter(p), platform: p }))
    : listAdapters().map((a) => ({ adapter: a, platform: a.platform }));

  for (const { adapter, platform } of adapters) {
    if (!adapter) {
      result.errors.push(`No adapter registered for ${platform}`);
      continue;
    }
    // Account metrics
    try {
      const accountMetrics = await adapter.collectAccountMetrics();
      createMetric({
        platform,
        metric_type: "account",
        collected_at: accountMetrics.collectedAt,
        followers: accountMetrics.followers,
        raw_data: accountMetrics.rawData,
      });
      result.accountMetricsCollected++;
    } catch (err) {
      result.errors.push(`Account ${platform}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Post metrics + comments for published records on this platform
    const records = listPublishRecords({ platform, status: "published" });
    for (const record of records) {
      if (!record.platform_post_id) continue;

      try {
        const metric = await adapter.collectPostMetrics(record.platform_post_id);
        createMetric({
          publish_record_id: record.id,
          platform,
          metric_type: "work",
          external_id: record.platform_post_id,
          collected_at: metric.collectedAt,
          views: metric.views,
          likes: metric.likes,
          comments: metric.comments,
          shares: metric.shares,
          collects: metric.collects,
          completion_rate: metric.completionRate,
          raw_data: metric.rawData,
        });
        result.metricsCollected++;
      } catch (err) {
        result.errors.push(`Metric ${platform}/${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const existingIds = new Set(
          listComments({ publishRecordId: record.id, limit: 500 })
            .map((c) => c.external_comment_id)
            .filter((id): id is string => !!id)
        );
        let cursor: string | undefined;
        do {
          const page = await adapter.collectComments(record.platform_post_id, cursor);
          for (const c of page.comments) {
            if (c.externalCommentId && existingIds.has(c.externalCommentId)) continue;
            createComment({
              publish_record_id: record.id,
              external_comment_id: c.externalCommentId,
              author_name: c.authorName,
              author_id: c.authorId,
              content: c.content,
              sentiment: classifySentiment(c.content),
              is_reply: c.isReply,
              parent_external_id: c.parentExternalId,
              replied: false,
              collected_at: c.collectedAt,
            });
            result.commentsCollected++;
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        result.errors.push(`Comments ${platform}/${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

export { getLatestAccountMetric };

/**
 * Backward-compatible accessor for the latest creator account data.
 */
export function getLatestCreatorData(platform: string): DbPlatformMetric | undefined {
  return getLatestAccountMetric(platform);
}

/**
 * No-op: the new adapter-based collection is driven by the analytics scheduler.
 * Kept for callers that may still import it; does not start the legacy Python collector.
 */
export function startAnalyticsCollector(): void {
  console.log("[analytics-collector] legacy collector disabled; use analytics-scheduler instead");
}

/**
 * No-op companion for startAnalyticsCollector.
 */
export function stopAnalyticsCollector(): void {
  // nothing to stop
}
