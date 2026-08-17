/**
 * 三家 LLM provider 预设（2026-08-16 架构改造 Phase 0）。
 * 均为 OpenAI ChatCompletions 兼容协议，同一 OpenAICompatProvider 实现按配置切换。
 * baseUrl/visionModel 可被 config.yaml 的 llm.providers.<key> 覆盖——此处只是出厂默认。
 */

export interface ProviderPreset {
  protocol: "openai";
  baseUrl: string;
  visionModel?: string;
  /** 平台服务端执行的联网搜索内置工具名(2026-08-17 实测:Kimi coding 端点 $web_search 两段协议可用) */
  builtinSearchTool?: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    visionModel: undefined,  // 公开 API 无视觉（2026-08-16 实证）；用 glm-4v
  },
  kimi: {
    protocol: "openai",
    // Coding Plan（sk-kimi-* key）专用端点；普通平台 key（sk-*）应改为 https://api.moonshot.cn/v1
    baseUrl: "https://api.kimi.com/coding/v1",
    visionModel: "kimi-for-coding",
    builtinSearchTool: "$web_search",
  },
  glm: {
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    visionModel: "glm-4v",
  },
};
