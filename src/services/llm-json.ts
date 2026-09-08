/**
 * Reusable LLM JSON prompt runner.
 *
 * 2026-08-18 P3-T1：从 spawn Claude CLI 切换为 LLM 直连（provider.chatJson），
 * 模型由 llm.models[stage] 分阶段路由决定（设置页「大模型直连」配置）。
 * 重试/超时/JSON 提取全部由 OpenAICompatProvider.chatJson 内建（withRetry + 输出纪律）。
 */

import { loadConfig } from "../config.js";
import { resolveModelFor, getProvider } from "../llm/registry.js";
import type { StageKey } from "../llm/types.js";

// 兼容导出：历史调用方/测试从此处取（实现已迁至 llm/json-extract.ts）
export { extractJsonFromText } from "../llm/json-extract.js";

export interface LlmJsonOptions {
  /** 分阶段路由键（默认 script 档——杂项 JSON 生成走便宜快模型） */
  stage?: StageKey;
  /** @deprecated CLI 时代残留（"sonnet"/"haiku"），直连架构下忽略——模型由 llm.models[stage] 决定 */
  model?: string;
  timeoutMs?: number;
  /** 输出 token 上限（2026-09-07 新增）：大产物场景（整片模板 HTML/长脚本）显式调高,
   *  缺省由 provider 层给 32768(此前不传走供应商缺省 4096,长 JSON 被静默截断) */
  maxTokens?: number;
  /** 最大尝试次数（含首次），默认 3。限流/超时/解析失败均会指数退避重试。 */
  maxAttempts?: number;
  /** 主阶段外部服务故障(5xx/网络)后的兜底阶段(2026-09-02 kimi 504 事故):
   *  仅对服务商故障降级,JSON 解析失败/4xx 不回退(那是 prompt 问题,换模型无用) */
  fallbackStage?: StageKey;
  /** 强制指定模型(2026-09-07 指令分流):"provider:model" 格式,绕过阶段路由——
   *  结构改造类任务(手写 SVG 几何)需要强模型通道(kimi-for-coding),不走默认 plan 档 */
  forceModel?: string;
}

/** 外部服务故障判定(导出供单测):5xx 网关错误/429 持续限流/连接错误/超时——这类故障换 provider 有意义 */
export function isExternalServiceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /LLM API (5\d\d|429)|ECONN|ETIMEDOUT|fetch failed|aborted|timed? ?out/i.test(msg);
}

/**
 * 带重试的 JSON 生成入口（直连版）。
 * 历史上（2026-07-21 Bug3）批量并发触发 Claude CLI 订阅限流；
 * 直连后限流/超时由 chatJson 的 withRetry 指数退避承载，串行队列语义不变。
 * fallbackStage:主阶段尝试耗尽后仍 5xx/网络故障 → 整体换兜底阶段重试(2026-09-02)。
 */
export async function runJsonPrompt<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
  const config = await loadConfig();
  const stage = opts.stage ?? "script";
  const call = async (s: StageKey) => {
    // 指令分流(2026-09-07):forceModel 显式指定时绕过阶段路由
    if (opts.forceModel && s === stage) {
      const [pk, m] = opts.forceModel.split(":");
      if (pk && m) {
        return getProvider(config, pk).chatJson<T>(prompt, {
          model: m, timeoutMs: opts.timeoutMs, maxAttempts: opts.maxAttempts,
          maxTokens: opts.maxTokens, usageStage: s,
        });
      }
    }
    const { provider, model } = resolveModelFor(config, s);
    return provider.chatJson<T>(prompt, {
      model,
      timeoutMs: opts.timeoutMs,
      maxAttempts: opts.maxAttempts,
      maxTokens: opts.maxTokens,
      usageStage: s, // 2026-08-19 P1:直连记账(stage 级;workId 无上下文时为空)
    });
  };
  try {
    return await call(stage);
  } catch (err) {
    if (!opts.fallbackStage || opts.fallbackStage === stage || !isExternalServiceError(err)) throw err;
    console.warn(`[llm-json] stage=${stage} 外部服务故障,回退 stage=${opts.fallbackStage}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    return call(opts.fallbackStage);
  }
}
