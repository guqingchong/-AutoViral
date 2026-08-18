/**
 * LLM provider 注册与分阶段模型路由（2026-08-16 架构改造 Phase 0）。
 * 设计文档：docs/desigen/01-LLM直连架构-详细设计方案.md §3.4
 *
 * 路由规则：
 * - llm.models[stage] 支持 "providerKey:modelId"（跨 provider）或裸 modelId（走 defaultProvider）
 * - provider 未配置/缺 apiKey → 抛可读错误（指引去设置页配置）
 * - provider 实例懒构造 + 缓存
 */

import type { Config } from "../config.js";
import type { LlmProvider, StageKey } from "./types.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { PROVIDER_PRESETS } from "./provider-keys.js";

const providerCache = new Map<string, LlmProvider>();

/** 按 key 取 provider 实例（懒构造）。预设可被 config.llm.providers[key] 覆盖 baseUrl/apiKey/visionModel */
export function getProvider(config: Config, key?: string): LlmProvider {
  const providerKey = key ?? config.llm?.defaultProvider ?? "deepseek";
  const cached = providerCache.get(providerKey);
  if (cached) return cached;

  const preset = PROVIDER_PRESETS[providerKey];
  const override = config.llm?.providers?.[providerKey];
  if (override?.enabled === false) {
    throw new Error(`LLM provider "${providerKey}" 已在设置页停用——请启用或改用其他 provider`);
  }
  const baseUrl = override?.baseUrl ?? preset?.baseUrl;
  const apiKey = override?.apiKey ?? "";
  if (!baseUrl) {
    throw new Error(`LLM provider "${providerKey}" 未知且未配置 baseUrl——请在设置页「大模型直连」配置`);
  }
  if (!apiKey) {
    throw new Error(`LLM provider "${providerKey}" 未配置 apiKey——请在设置页「大模型直连」配置`);
  }
  const protocol = override?.protocol ?? preset?.protocol ?? "openai";
  if (protocol !== "openai") {
    throw new Error(`provider "${providerKey}" 的 protocol=${protocol} 尚未实现（一期仅 openai 兼容）`);
  }
  const provider = new OpenAICompatProvider(providerKey, {
    baseUrl,
    apiKey,
    passReasoningBack: override?.passReasoningBack ?? preset?.passReasoningBack ?? false,
  });
  providerCache.set(providerKey, provider);
  return provider;
}

/** 取 provider 的视觉模型名（配置覆盖 > 预设） */
export function getVisionModel(config: Config, key?: string): string | undefined {
  const providerKey = key ?? config.llm?.defaultProvider ?? "deepseek";
  return config.llm?.providers?.[providerKey]?.visionModel ?? PROVIDER_PRESETS[providerKey]?.visionModel;
}

/** 分阶段路由：llm.models[stage] → { provider, model } */
export function resolveModelFor(config: Config, stage: StageKey): { provider: LlmProvider; model: string } {
  const spec = config.llm?.models?.[stage];
  let providerKey = config.llm?.defaultProvider ?? "deepseek";
  let model = spec;
  if (spec?.includes(":")) {
    const [k, m] = spec.split(":", 2);
    providerKey = k;
    model = m;
  }
  if (!model) {
    throw new Error(`llm.models.${stage} 未配置模型——请在设置页「大模型直连」配置阶段模型`);
  }
  return { provider: getProvider(config, providerKey), model };
}

/** 测试/热更新用：清空 provider 缓存 */
export function _resetProviders(): void {
  providerCache.clear();
}
