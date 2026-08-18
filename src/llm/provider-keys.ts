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
  /** 多轮回填时 assistant 消息是否携带 reasoning_content（thinking 模式供应商的强制要求,
   *  不回填则 400:The `reasoning_content` in the thinking mode must be passed back to the API。
   *  2026-08-18 实测 deepseek-v4-pro(长链工具回合)与 kimi-for-coding 均要求回填）
   */
  passReasoningBack?: boolean;
  /** 阶段路由下拉的建议模型清单(P3-T3 设置页选项来源,仅建议——用户可手输自定义值) */
  modelSuggestions?: string[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    visionModel: undefined,  // 公开 API 无视觉（2026-08-16 实证）；用 glm-4v
    // 2026-08-18 实测:deepseek-v4-pro 长链工具回合强制要求回填 reasoning_content
    // (400: The `reasoning_content` in the thinking mode must be passed back)，短链不触发
    passReasoningBack: true,
    modelSuggestions: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  kimi: {
    protocol: "openai",
    // Coding Plan（sk-kimi-* key）专用端点；普通平台 key（sk-*）应改为 https://api.moonshot.cn/v1
    baseUrl: "https://api.kimi.com/coding/v1",
    visionModel: "kimi-for-coding",
    builtinSearchTool: "$web_search",
    passReasoningBack: true,
    modelSuggestions: ["kimi-for-coding"],
  },
  glm: {
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    visionModel: "glm-4v",
    modelSuggestions: ["glm-4v", "glm-4.6"],
  },
};
