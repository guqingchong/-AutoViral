/**
 * LLM 用量记账 + 日预算熔断（2026-08-18 P3-T2）。
 *
 * - 每次 chatStream 完成（usage 事件）落一条 llm_usage；
 * - 成本按 config.llm.priceTable（元/百万 tokens）估算，缺价目记 0 但不阻断记账；
 * - 日累计超 budget.dailyLimitYuan → 全部 running/queued 队列项置 paused + 错误日志
 *   （恢复入口：设置页改预算或次日自动——runner 只跳过 paused，不自动唤醒）。
 *
 * 2026-08-28 批次8.6:成本台账修复——cost 恒 0 的根因是 priceTable 纯缺配
 * (逻辑正确但全库无默认值写入)。现在:内置默认刊例价 + 未知模型 warn(不再静默归零)。
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
  /** 批次8.7:调用墙钟(毫秒)与思考 token 估算(可选,缺省 null) */
  latencyMs?: number;
  thinkingTokens?: number;
}

/** 内置默认刊例价(元/百万 tokens,2026-08-28 公开刊例估算值,设置页 priceTable 可覆盖)。
 *  注意:key 是 provider:model 精确匹配,新增模型必须同步加行 */
const DEFAULT_PRICE_TABLE: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "deepseek:deepseek-v4-flash": { input: 2, output: 8, cacheRead: 0.2 },
  "deepseek:deepseek-v4-pro": { input: 4, output: 12, cacheRead: 0.4 },
  "deepseek:deepseek-v4-flash-vision-exp": { input: 2, output: 8, cacheRead: 0.2 },
  "kimi:kimi-for-coding": { input: 6, output: 24 },
  "glm:glm-4v": { input: 4, output: 12 },
  "glm:glm-4.6": { input: 2, output: 8 },
  "glm:glm-5.3-flash": { input: 1.1, output: 3.6, cacheRead: 0.2 }, // $0.15/$0.50 刊例
};

/** 未知模型 warn 去重(每个模型只警告一次,防刷屏) */
const warnedUnknownModels = new Set<string>();

/** 按价目表估算单次成本（元）。priceTable key 形如 "deepseek:deepseek-v4-pro";
 *  用户配置优先,缺省回落内置刊例;两边都没有 → warn 并记 0(不再静默) */
export function estimateCostYuan(config: Config, r: UsageRecord): number {
  const key = `${r.provider}:${r.model}`;
  const price = config.llm?.priceTable?.[key] ?? DEFAULT_PRICE_TABLE[key];
  if (!price) {
    if (!warnedUnknownModels.has(key)) {
      warnedUnknownModels.add(key);
      console.warn(`[llm-usage] 未知模型 ${key} 无价目(内置刊例与用户配置均未覆盖),成本记 0——请在设置页补 priceTable`);
    }
    return 0;
  }
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
      `INSERT INTO llm_usage (work_id, stage, provider, model, input_tokens, output_tokens, cache_read, cost_yuan, latency_ms, thinking_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(r.workId ?? null, r.stage ?? null, r.provider, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens ?? 0, cost, r.latencyMs ?? null, r.thinkingTokens ?? null);
  // C2 补修(2026-09):LLM 成本同步入 work_costs 分项账（回写 works.actual_cost）
  if (r.workId && cost > 0) {
    recordWorkCost(r.workId, "llm", r.provider, cost, r.stage ?? undefined);
  }
}

/**
 * C2 补修(2026-09):作品级成本分项记账——写 work_costs 表 + 回写 works.actual_cost。
 * 此前只有 llm_usage 记 LLM token 成本，TTS/BGM/GPU 全未入账，works.actual_cost 恒 0。
 * 幂等安全：金额 ≤0 或 workId 缺失直接跳过；同步写、单事务内两表一致。
 */
export function recordWorkCost(workId: string, category: "llm" | "tts" | "bgm" | "gpu", provider: string | null, amount: number, detail?: string): void {
  if (!workId || !Number.isFinite(amount) || amount <= 0) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO work_costs (work_id, category, provider, amount, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workId, category, provider, amount, detail ?? null, new Date().toISOString());
  db.prepare(`UPDATE works SET actual_cost = COALESCE(actual_cost, 0) + ? WHERE id = ?`).run(amount, workId);
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

/** 软预警/熔断告警的日内去重(换日自动复位) */
let lastSoftWarnDate = "";
let lastBreachAlertDate = "";

/** 超预算判定 + 熔断执行。返回 true 表示已熔断（本函数幂等，可每次记账后调用） */
export function enforceDailyBudget(
  config: Config,
  pauseAll: () => number /* 返回被暂停的队列项数 */,
): boolean {
  const limit = config.budget?.dailyLimitYuan;
  if (!limit || limit <= 0) return false;
  const spent = getDailyCostYuan();
  const today = new Date().toLocaleDateString("sv-SE"); // 本地日期 YYYY-MM-DD
  const warnPct = config.budget?.warningThresholdPercent ?? 80;

  // X10 验收修复(C1,2026-09-07):80% 软预警此前只有月度看板有,日维度没有——
  // 9/3 击穿 400→423 全程无任何预警。每日最多播报一次。
  if (spent >= (limit * warnPct) / 100 && spent < limit && lastSoftWarnDate !== today) {
    lastSoftWarnDate = today;
    const text = `日预算预警:今日已花 ¥${spent.toFixed(2)},达上限 ¥${limit} 的 ${Math.round((spent / limit) * 100)}%`;
    console.warn(`[llm-usage] ${text}`);
    void import("./fail-visible.js").then((m) =>
      m.failVisible({ stage: "budget" }, text),
    ).catch(() => {});
  }

  if (spent < limit) return false;
  const paused = pauseAll();
  console.error(`[llm-usage] 日预算熔断:今日已花 ¥${spent.toFixed(2)} ≥ 上限 ¥${limit},暂停 ${paused} 个队列项`);
  // X10 验收修复(C1,2026-09-07):熔断此前仅 console.error,无 failVisible 语音告警——
  // 预算打穿时用户零感知。每日最多语音播报一次(voice-notify 自身另有 3min 防抖)。
  if (lastBreachAlertDate !== today) {
    lastBreachAlertDate = today;
    void import("./fail-visible.js").then((m) =>
      m.failVisible({ stage: "budget" }, `日预算熔断:今日已花 ¥${spent.toFixed(2)},超上限 ¥${limit},已暂停队列`, { fatal: false }),
    ).catch(() => {});
  }
  return true;
}
