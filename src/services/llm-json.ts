/**
 * Reusable LLM JSON prompt runner.
 *
 * 2026-08-18 P3-T1：从 spawn Claude CLI 切换为 LLM 直连（provider.chatJson），
 * 模型由 llm.models[stage] 分阶段路由决定（设置页「大模型直连」配置）。
 * 重试/超时/JSON 提取全部由 OpenAICompatProvider.chatJson 内建（withRetry + 输出纪律）。
 */

import { loadConfig } from "../config.js";
import { resolveModelFor } from "../llm/registry.js";
import type { StageKey } from "../llm/types.js";

// 兼容导出：历史调用方/测试从此处取（实现已迁至 llm/json-extract.ts）
export { extractJsonFromText } from "../llm/json-extract.js";

export interface LlmJsonOptions {
  /** 分阶段路由键（默认 script 档——杂项 JSON 生成走便宜快模型） */
  stage?: StageKey;
  /** @deprecated CLI 时代残留（"sonnet"/"haiku"），直连架构下忽略——模型由 llm.models[stage] 决定 */
  model?: string;
  timeoutMs?: number;
  /** 最大尝试次数（含首次），默认 3。限流/超时/解析失败均会指数退避重试。 */
  maxAttempts?: number;
}

/**
 * 带重试的 JSON 生成入口（直连版）。
 * 历史上（2026-07-21 Bug3）批量并发触发 Claude CLI 订阅限流；
 * 直连后限流/超时由 chatJson 的 withRetry 指数退避承载，串行队列语义不变。
 */
export async function runJsonPrompt<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
  const config = await loadConfig();
  const { provider, model } = resolveModelFor(config, opts.stage ?? "script");
  return provider.chatJson<T>(prompt, {
    model,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    usageStage: opts.stage ?? "script", // 2026-08-19 P1:直连记账(stage 级;workId 无上下文时为空)
  });
}
