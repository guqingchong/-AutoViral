/**
 * LLM 用量记账 + 日预算熔断（2026-08-18 P3-T2）。
 *
 * - 每次 chatStream 完成（usage 事件）落一条 llm_usage；
 * - 成本按 config.llm.priceTable（元/百万 tokens）估算，缺价目记 0 但不阻断记账；
 * - 日累计超 budget.dailyLimitYuan → 全部 running/queued 队列项置 paused + 错误日志
 *   （恢复入口：设置页改预算或次日自动——runner 只跳过 paused，不自动唤醒）。
 */

import { getDb } from "../db/connection.js";
import type { Config } from "../config.js";

export interface UsageRecord {
  workId?: string;
  stage?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/** 按价目表估算单次成本（元）。priceTable key 形如 "deepseek:deepseek-v4-pro" */
export function estimateCostYuan(config: Config, r: UsageRecord): number {
  const price = config.llm?.priceTable?.[`${r.provider}:${r.model}`];
  if (!price) return 0;
  return (
    (r.inputTokens * price.input) / 1e6 +
    (r.outputTokens * price.output) / 1e6 +
    ((r.cacheReadTokens ?? 0) * (price.cacheRead ?? 0)) / 1e6
  );
}

export function recordUsage(config: Config, r: UsageRecord): void {
  const cost = estimateCostYuan(config, r);
  getDb()
    .prepare(
      `INSERT INTO llm_usage (work_id, stage, provider, model, input_tokens, output_tokens, cache_read, cost_yuan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.workId ?? null, r.stage ?? null, r.provider, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens ?? 0, cost);
}

/** 今日累计成本（元）。按本地日期切（llm_usage.ts 存 UTC datetime('now')，+8h 换算） */
export function getDailyCostYuan(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(cost_yuan), 0) AS total FROM llm_usage
       WHERE date(ts, '+8 hours') = date('now', '+8 hours')`,
    )
    .get() as { total: number };
  return row.total;
}

/**
 * 直连路径记账入口(2026-08-19 P1):fire-and-forget,内部加载 config,永不抛出。
 * 背景:记账此前只在 agent loop 的 chatStream usage 事件里,chatJson /
 * chatVisionJson / chatJsonWithSearch 全部漏账(调研/克隆/评审蒸馏是大头),
 * 日预算熔断看到的只是部分花费。
 */
export function recordUsageAsync(r: UsageRecord): void {
  void (async () => {
    try {
      const { loadConfig } = await import("../config.js");
      recordUsage(await loadConfig(), r);
    } catch (err) {
      console.warn("[llm-usage] 直连记账失败(不阻断):", err instanceof Error ? err.message : err);
    }
  })();
}

/** 超预算判定 + 熔断执行。返回 true 表示已熔断（本函数幂等，可每次记账后调用） */
export function enforceDailyBudget(
  config: Config,
  pauseAll: () => number /* 返回被暂停的队列项数 */,
): boolean {
  const limit = config.budget?.dailyLimitYuan;
  if (!limit || limit <= 0) return false;
  const spent = getDailyCostYuan();
  if (spent < limit) return false;
  const paused = pauseAll();
  console.error(`[llm-usage] 日预算熔断:今日已花 ¥${spent.toFixed(2)} ≥ 上限 ¥${limit},暂停 ${paused} 个队列项`);
  return true;
}
