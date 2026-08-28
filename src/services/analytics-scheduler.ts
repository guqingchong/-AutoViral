/**
 * Analytics collection scheduler.
 *
 * Runs periodic collection of platform metrics and comments.
 * Uses node-cron for scheduling.
 * Collects: account metrics every 24h, post metrics every 6h during first 72h, then every 24h.
 */

import { listPublishRecords } from "../db/publish-records-repo.js";
import { createMetric } from "../db/platform-metrics-repo.js";
import { failVisible } from "./fail-visible.js";
import { listAccounts } from "../db/accounts-repo.js";
import { getAdapterForAccount, listAdapters } from "./platform-adapters/registry.js";
import { collectComments } from "./comment-service.js";
import { analyzeWork, computeBaseline } from "./hit-failure-analysis.js";
import { evolveFromPerformance } from "./self-evolution.js";
import { createBaseline as createBaselineRecord } from "../db/baselines-repo.js";
import { getWork } from "../work-store.js";
import { collectAll } from "../analytics-collector.js";
import { collectFeedback } from "./feedback-loop.js";
import { getTopic } from "../db/topics-repo.js";
import { getDb } from "../db/connection.js";
import cron from "node-cron";
import type { Config } from "../config.js";

/** 自进化去重(2026-08-19):同一发布记录的同一判定只进化一次 */
function hasEvolved(recordId: number, verdict: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM evolution_marks WHERE record_id = ? AND verdict = ?").get(recordId, verdict);
}
function markEvolved(recordId: number, verdict: string): void {
  getDb().prepare("INSERT OR IGNORE INTO evolution_marks (record_id, verdict) VALUES (?, ?)").run(recordId, verdict);
}

let accountJob: cron.ScheduledTask | null = null;
let metricsJob: cron.ScheduledTask | null = null;
let baselineJob: cron.ScheduledTask | null = null;

// 批次9.3(A-2):cron 重入防护——上一轮没跑完(慢账号/慢网络)时跳过本轮,不叠加
let accountRunning = false;
let metricsRunning = false;

/**
 * Start the analytics scheduler.
 * @param accountCron - Cron expression for account metric collection (default: daily at 3am)
 * @param metricsCron - Cron expression for post metric collection (default: every 6 hours)
 * @param baselineCron - Cron expression for baseline computation (default: weekly Monday 4am)
 */
export function startScheduler(
  accountCron = "0 3 * * *",
  metricsCron = "0 */6 * * *",
  baselineCron = "0 4 * * 1"
): void {
  // 幂等防护(2026-08-19):重复启动会叠加 cron 任务导致指标双倍写入
  if (accountJob || metricsJob || baselineJob) stopScheduler();
  console.log("[analytics-scheduler] starting...");

  // Account metrics: daily —— 遍历活跃账号(Task 8),单账号失败跳过不拖死整轮
  accountJob = cron.schedule(accountCron, async () => {
    if (accountRunning) { console.warn("[analytics-scheduler] 上一轮账号采集未完成,跳过本轮(重入防护)"); return; }
    accountRunning = true;
    try {
    console.log("[analytics-scheduler] collecting account metrics...");
    const accounts = listAccounts().filter((a) => !a.status || a.status === "active");
    for (const account of accounts) {
      const adapter = getAdapterForAccount(account.platform, account.id);
      if (!adapter) continue;
      try {
        const metrics = await adapter.collectAccountMetrics();
        // 批次7.8(A-4):登录态失效时选择器全空,undefined 垃圾指标照常入库——
        // 拒收并通知(登录态失效要告警,不是静默)
        if (metrics.followers === undefined || metrics.followers === null) {
          console.warn(`[analytics-scheduler] ${account.platform}/${account.name} 指标为空(疑似登录态失效),垃圾指标未入库`);
          failVisible({ stage: "analytics" }, `${account.platform}/${account.name} 指标采集为空,疑似登录态失效——请到渠道页重新扫码`);
          continue;
        }
        await createMetric({
          platform: account.platform,
          account_id: account.id,
          metric_type: "account",
          collected_at: metrics.collectedAt,
          followers: metrics.followers,
          raw_data: metrics.rawData,
        });
        console.log(`[analytics-scheduler] ${account.platform}/${account.name} account: followers=${metrics.followers}`);
      } catch (e) {
        console.error(`[analytics-scheduler] ${account.platform}/${account.name} 采集失败(跳过):`, e);
      }
    }
    // P3-T4 数据回流:发布满 48h 的作品抓三率 → topic_scores(选题权重)
    try {
      const fb = collectFeedback();
      console.log(`[analytics-scheduler] 数据回流:三率入库 ${fb.processed} 条,跳过 ${fb.skipped} 条`);
    } catch (e) {
      console.error("[analytics-scheduler] 数据回流失败:", e);
    }
    } finally { accountRunning = false; }
  });

  // Post metrics: every 6 hours
  metricsJob = cron.schedule(metricsCron, async () => {
    if (metricsRunning) { console.warn("[analytics-scheduler] 上一轮作品采集未完成,跳过本轮(重入防护)"); return; }
    metricsRunning = true;
    try {
    console.log("[analytics-scheduler] collecting post metrics...");

    // 2026-08-19 P2 审核对账:reviewing 记录(平台审核中)用 post_id 探测转正/转拒。
    // 此前"审核中一律当已发布",拒审作品永远显示已发布,48h 窗口还从提交时刻起算
    const reviewing = listPublishRecords({ status: "reviewing" });
    for (const record of reviewing) {
      if (!record.platform_post_id) continue; // 无 id 无法探测,等发布侧解析补录
      const adapter = getAdapterForAccount(record.platform, record.account_id ?? undefined);
      if (!adapter) continue;
      try {
        const m = await adapter.collectPostMetrics(record.platform_post_id);
        // 能采到指标 = 已过审上线 → 转正,published_at 从过审时刻起算
        const { updatePublishRecord } = await import("../db/publish-records-repo.js");
        updatePublishRecord(record.id, { status: "published", published_at: new Date().toISOString() });
        console.log(`[analytics-scheduler] 审核对账:${record.platform}#${record.id} 已过审(${m.views ?? 0} 播放),转 published`);
      } catch {
        // 采不到 = 仍在审核或被拒;超过 72h 未过审标记 failed(平台审核不会这么久)
        const submittedAt = record.updated_at ? new Date(record.updated_at).getTime() : 0;
        if (Date.now() - submittedAt > 72 * 3600_000) {
          const { updatePublishRecord } = await import("../db/publish-records-repo.js");
          updatePublishRecord(record.id, { status: "failed", error_message: "审核 72h 未通过(被拒或平台异常)" });
          console.warn(`[analytics-scheduler] 审核对账:${record.platform}#${record.id} 72h 未过审,标 failed`);
        }
      }
    }

    const published = listPublishRecords({ status: "published" });
    const now = new Date();
    const cutoff72h = new Date(now.getTime() - 72 * 3600_000);
    const cutoff7d = new Date(now.getTime() - 7 * 24 * 3600_000);

    for (const record of published) {
      // Only collect for posts less than 7 days old
      const publishedAt = record.published_at ? new Date(record.published_at) : null;
      if (!publishedAt || publishedAt < cutoff7d) continue;
      // For posts older than 72h, only collect once per day (skip if the hour isn't ~0-6)
      if (publishedAt < cutoff72h && now.getHours() > 6) continue;

      const adapter = getAdapterForAccount(record.platform, record.account_id ?? undefined);
      if (!adapter || !record.platform_post_id) continue;

      try {
        const metrics = await adapter.collectPostMetrics(record.platform_post_id);
        if (metrics.views === undefined && metrics.likes === undefined) {
          console.warn(`[analytics-scheduler] ${record.platform}#${record.id} 作品指标为空(疑似登录态失效),未入库`);
          continue;
        }
        await createMetric({
          publish_record_id: record.id,
          platform: record.platform,
          account_id: record.account_id ?? null,
          metric_type: "work",
          external_id: record.platform_post_id,
          collected_at: metrics.collectedAt,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          collects: metrics.collects,
          completion_rate: metrics.completionRate,
          raw_data: metrics.rawData,
        });

        // Collect comments for the first 72h
        if (publishedAt >= cutoff72h) {
          await collectComments(record.id, record.platform, record.platform_post_id);
        }

        // Run hit/failure analysis
        const analysis = analyzeWork(record.id);
        // 2026-08-19 修复:①去重——同一记录同一判定只进化一次(此前每 6h 重复生成,
        // 同一爆款每周 ~28 条重复规则且未记账白烧 LLM);②tags 此前误传平台列表
        // (work.platforms),应为选题内容标签
        if (analysis && analysis.verdict !== "normal" && !hasEvolved(record.id, analysis.verdict)) {
          const work = await getWork(record.work_id);
          if (work) {
            const topic = work.topicId != null ? getTopic(work.topicId) : undefined;
            await evolveFromPerformance({
              analysis,
              workTitle: work.title,
              tags: topic?.tags ?? [],
              emotionType: work.contentCategory,
            });
            markEvolved(record.id, analysis.verdict);
          }
        }
      } catch (e) {
        console.error(
          `[analytics-scheduler] ${record.platform} post ${record.id} error:`,
          e
        );
      }
    }
    } finally { metricsRunning = false; }
  });

  // Baseline computation: weekly
  baselineJob = cron.schedule(baselineCron, async () => {
    console.log("[analytics-scheduler] computing baselines...");
    for (const adapter of listAdapters()) {
      try {
        const baseline = computeBaseline(adapter.platform, "work_performance");
        if (baseline) {
          createBaselineRecord(baseline);
          console.log(
            `[analytics-scheduler] ${adapter.platform} baseline updated (n=${baseline.sample_count})`
          );
        }
      } catch (e) {
        console.error(`[analytics-scheduler] ${adapter.platform} baseline error:`, e);
      }
    }
  });

  console.log("[analytics-scheduler] started");
}

/**
 * Stop all scheduled jobs.
 */
export function stopScheduler(): void {
  accountJob?.stop();
  metricsJob?.stop();
  baselineJob?.stop();
  accountJob = null;
  metricsJob = null;
  baselineJob = null;
  console.log("[analytics-scheduler] stopped");
}

/**
 * Start the analytics scheduler only when analytics is enabled in config.
 */
export function startMetricsScheduler(analytics: Config["analytics"]): void {
  if (!analytics.enabled) {
    console.log("[analytics-scheduler] disabled");
    return;
  }
  startScheduler();
}

/**
 * Run a one-shot collection of all metrics (useful for manual trigger / testing).
 */
export async function collectAllOnce(options?: {
  accountId?: string;
  workId?: string;
}): Promise<{ accounts: number; posts: number; errors: string[] }> {
  const result = await collectAll(options);
  return {
    accounts: result.accountMetricsCollected,
    posts: result.metricsCollected,
    errors: result.errors,
  };
}

export async function triggerManualCollection(
  analytics: Config["analytics"]
): Promise<{ collected: boolean; accounts: number; posts: number; comments: number; errors: string[] }> {
  if (!analytics.enabled) {
    return { collected: false, accounts: 0, posts: 0, comments: 0, errors: [] };
  }
  const platforms = analytics.sources.map((s) => s.platform).filter(Boolean);
  const result = await collectAll(platforms.length ? platforms : undefined);
  return {
    collected: true,
    accounts: result.accountMetricsCollected,
    posts: result.metricsCollected,
    comments: result.commentsCollected,
    errors: result.errors,
  };
}
