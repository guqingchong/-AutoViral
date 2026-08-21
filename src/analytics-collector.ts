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

import { getAdapter, getAdapterForAccount, listPlatforms } from "./services/platform-adapters/registry.js";
import { normalizePlatformKey, toAccountPlatformKey } from "./services/credential-resolver.js";
import { listPublishRecords } from "./db/publish-records-repo.js";
import { listAccounts } from "./db/accounts-repo.js";
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

export interface CollectAllOptions {
  /** 限定平台(旧数组形式的等价物) */
  platforms?: string[];
  /** 只采该账号(账号指标 + 该账号的作品指标) */
  accountId?: string;
  /** 只采该作品下的发布记录 */
  workId?: string;
}

/**
 * Collect metrics and comments by iterating active accounts (Task 8).
 * 账号指标按账号落 account_id;作品指标按 publish_record.account_id 取 adapter,
 * account_id 为 NULL 的历史记录回落平台默认实例。
 * 无账号的平台回落平台级采集(旧行为)。兼容旧签名 collectAll(platforms?: string[])。
 */
export async function collectAll(options?: string[] | CollectAllOptions): Promise<CollectorResult> {
  const opts: CollectAllOptions = Array.isArray(options) ? { platforms: options } : options ?? {};
  const result: CollectorResult = {
    metricsCollected: 0,
    commentsCollected: 0,
    accountMetricsCollected: 0,
    errors: [],
  };

  const targetPlatforms = opts.platforms ?? listPlatforms();
  // 2026-08-21 终审 C1:平台匹配双侧归一(账号/发布记录用 wechat_mp,注册侧用 wechat)
  const normalizedTargets = new Set(targetPlatforms.map(normalizePlatformKey));

  // 显式指定平台但未注册 adapter → 记录错误(保持旧行为)
  if (opts.platforms) {
    for (const p of opts.platforms) {
      if (!getAdapter(p)) result.errors.push(`No adapter registered for ${p}`);
    }
  }

  // Account metrics:遍历活跃账号,单账号失败跳过
  const accounts = listAccounts().filter(
    (a) =>
      (!a.status || a.status === "active") &&
      normalizedTargets.has(normalizePlatformKey(a.platform)) &&
      (!opts.accountId || a.id === opts.accountId)
  );
  const platformsWithAccounts = new Set(accounts.map((a) => normalizePlatformKey(a.platform)));
  for (const account of accounts) {
    const adapter = getAdapterForAccount(account.platform, account.id);
    if (!adapter) continue;
    try {
      const accountMetrics = await adapter.collectAccountMetrics();
      createMetric({
        platform: account.platform,
        account_id: account.id,
        metric_type: "account",
        collected_at: accountMetrics.collectedAt,
        followers: accountMetrics.followers,
        raw_data: accountMetrics.rawData,
      });
      result.accountMetricsCollected++;
    } catch (err) {
      result.errors.push(`Account ${account.platform}/${account.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 无活跃账号的平台回落平台级采集(旧行为;指定 accountId 时不回落)
  if (!opts.accountId) {
    for (const platform of targetPlatforms) {
      if (platformsWithAccounts.has(normalizePlatformKey(platform))) continue;
      const adapter = getAdapter(platform);
      if (!adapter) continue;
      try {
        const accountMetrics = await adapter.collectAccountMetrics();
        createMetric({
          // 指标行 platform 统一写账号侧键(wechat → wechat_mp),消除两键混存(终审 M2)
          platform: toAccountPlatformKey(platform),
          metric_type: "account",
          collected_at: accountMetrics.collectedAt,
          followers: accountMetrics.followers,
          raw_data: accountMetrics.rawData,
        });
        result.accountMetricsCollected++;
      } catch (err) {
        result.errors.push(`Account ${platform}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Post metrics + comments for published records
  let records = listPublishRecords({ status: "published" }).filter((r) => normalizedTargets.has(normalizePlatformKey(r.platform)));
  if (opts.accountId) records = records.filter((r) => r.account_id === opts.accountId);
  if (opts.workId) records = records.filter((r) => r.work_id === opts.workId);

  for (const record of records) {
    if (!record.platform_post_id) continue;
    const adapter = getAdapterForAccount(record.platform, record.account_id ?? undefined);
    if (!adapter) continue;
    const platform = record.platform;

    try {
      const metric = await adapter.collectPostMetrics(record.platform_post_id);
      createMetric({
        publish_record_id: record.id,
        platform,
        account_id: record.account_id ?? null,
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
