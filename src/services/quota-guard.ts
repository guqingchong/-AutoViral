/**
 * LLM 配额防护(2026-08-17 LLM 直连架构 P2-T4 / 门禁 A3)。
 *
 * 背景:2026-08-16 订阅配额撞墙事件——CLI 报 "403 usage limit for this billing
 * cycle" 后 runner 不知情继续反复恢复,撞墙一整晚。本模块提供:
 * - QuotaExhaustedError:provider/loop 层把 quota 文本错误分类成可识别类型
 * - 全局配额状态:任一链路报配额耗尽 → 冷却期;work-queue 在冷却期把 running
 *   项置 paused(不 incrementResumeAttempts),到点单次试探,失败指数回退
 * - 任一 LLM 调用成功 → 立即解除(试探成功的正信号)
 */

export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

const QUOTA_PATTERN = /usage limit|quota|insufficient.?credits|billing cycle|余额不足/i;
// 注:429/rate limit 是瞬时限流,withRetry 层已指数退避,不算配额耗尽
// (2026-08-19 曾把 rate.?limit 加入本模式,导致瞬时限流也触发 30min 全局冷却——回退)

export function isQuotaErrorText(text: string): boolean {
  return QUOTA_PATTERN.test(text);
}

interface QuotaState {
  exhausted: boolean;
  since: number;      // 首次耗尽时间
  probeAt: number;    // 下次试探时间
  backoffMin: number; // 当前回退分钟数(失败后 ×2)
  lastSource: string;
}

const FIRST_BACKOFF_MIN = 30;
const MAX_BACKOFF_MIN = 240;

let state: QuotaState = { exhausted: false, since: 0, probeAt: 0, backoffMin: FIRST_BACKOFF_MIN, lastSource: "" };

/** 任一链路报告配额耗尽。冷却期内重复报告(=试探失败)→ 回退翻倍 */
export function reportQuotaExhausted(source: string): void {
  const now = Date.now();
  if (state.exhausted) {
    // 冷却期内的再次耗尽 = 上次试探失败 → 指数回退
    state.backoffMin = Math.min(state.backoffMin * 2, MAX_BACKOFF_MIN);
  }
  state = {
    exhausted: true,
    since: state.exhausted ? state.since : now,
    probeAt: now + state.backoffMin * 60_000,
    backoffMin: state.backoffMin,
    lastSource: source,
  };
  console.warn(`[quota] LLM 配额耗尽(${source}),${state.backoffMin}min 后单次试探`);
}

/** LLM 调用成功 → 解除配额状态 */
export function reportQuotaSuccess(): void {
  if (!state.exhausted) return;
  console.log(`[quota] LLM 调用成功,配额状态解除(此前冷却 ${Math.round((Date.now() - state.since) / 60_000)}min)`);
  state = { exhausted: false, since: 0, probeAt: 0, backoffMin: FIRST_BACKOFF_MIN, lastSource: "" };
}

/** 当前是否允许启动新工作(冷却期 false;到试探窗口 true) */
export function quotaAllowsStart(): boolean {
  return !state.exhausted || Date.now() >= state.probeAt;
}

export function quotaState(): Readonly<QuotaState> {
  return { ...state };
}

/** 测试用 */
export function _resetQuota(): void {
  state = { exhausted: false, since: 0, probeAt: 0, backoffMin: FIRST_BACKOFF_MIN, lastSource: "" };
}
