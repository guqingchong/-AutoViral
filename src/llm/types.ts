/**
 * LLM 直连类型定义（2026-08-16 LLM 直连架构改造 Phase 0）。
 * 设计文档：docs/desigen/01-LLM直连架构-详细设计方案.md §3.1
 *
 * 消息/块结构与 Anthropic Messages API 对齐（provider 层负责转 OpenAI 等协议）。
 * 关键约定：
 * - system 独立字段（不混入 messages）——前缀缓存命中的前提
 * - 工具名逐字沿用 CLI 命名（Read/Write/Edit/Glob/Grep/Bash/WebSearch/AskUserQuestion），
 *   因为 system prompt 与 skills 全部按这些名字写成
 */

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** 服务端执行的内置工具(如 Kimi $web_search):loop 不在本地执行,arguments 原样回填 */
  builtin?: boolean;
  /** 流式累积的原始 arguments JSON——builtin 回填时逐字使用,避免 parse/stringify 失真 */
  rawArguments?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
  /** 工具名(OpenAI tool 消息的 name 字段;builtin 回填协议要求携带) */
  name?: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  base64: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

export interface AgentMessage {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 服务端执行的内置工具(如 Kimi $web_search)——provider 映射为 builtin_function,loop 不做本地执行 */
  builtin?: boolean;
}

export interface ChatRequest {
  model: string;
  /** 独立 system 字段——不再拼进 prompt 文本，前缀缓存命中的前提 */
  system: string;
  messages: AgentMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
  /** 当前模型是否接受图片(image_url 内容块)。false 时历史图片降格为文本占位——
   *  DeepSeek 文本模型等对 image_url 变体直接 400(2026-08-17 live 实证) */
  allowImages?: boolean;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** input JSON 完整后一次性发（对齐 CLI 按完整 block 发的行为） */
  | { type: "tool_use"; block: ToolUseBlock }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; latencyMs?: number; thinkingTokens?: number };

/** 分阶段路由键（llm.models 的可配项） */
export type StageKey = "research" | "plan" | "assets" | "assembly" | "eval" | "script";

export interface LlmProvider {
  readonly name: string;
  readonly protocol: "anthropic" | "openai";
  chatStream(
    req: ChatRequest,
    onEvent: (ev: StreamEvent) => void,
  ): Promise<{ stopReason: string; assistant: AgentMessage }>;
  /** 非流式 JSON 生成（替代 llm-json.ts 的 runJsonPrompt 语义） */
  chatJson<T>(prompt: string, opts: { model: string; timeoutMs?: number; maxAttempts?: number; usageStage?: string; usageWorkId?: string }): Promise<T>;
}
