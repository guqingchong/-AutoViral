/**
 * 带联网搜索的 JSON 生成（2026-08-18 P3-T1）。
 *
 * 替代 CLI 时代的 runResearchCli / collectTrends spawn 路径：
 * 声明平台内置搜索工具（如 Kimi $web_search，builtin_function 由平台服务端执行），
 * loop 只按 moonshot 协议把 arguments 逐字回填为 tool 消息，平台在下一轮请求时执行搜索。
 * 终局回合从文本中提取 JSON。
 */

import type { AgentMessage, LlmProvider, TextBlock, ToolUseBlock } from "./types.js";
import { extractJsonFromText, JSON_OUTPUT_DISCIPLINE } from "./json-extract.js";

export interface SearchJsonOptions {
  timeoutMs?: number;
  /** 搜索往返上限（每次 tool_use 计一轮），默认 8 */
  maxRounds?: number;
  /** 内置搜索工具名（如 "$web_search"）；不传则退化为无搜索单发 */
  builtinSearchTool?: string;
}

export async function chatJsonWithSearch<T>(
  provider: LlmProvider,
  model: string,
  prompt: string,
  opts: SearchJsonOptions = {},
): Promise<T> {
  const maxRounds = opts.maxRounds ?? 8;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8 * 60_000);

  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: prompt + JSON_OUTPUT_DISCIPLINE }] },
  ];
  const tools = opts.builtinSearchTool
    ? [{ name: opts.builtinSearchTool, description: "联网搜索", input_schema: { type: "object" }, builtin: true }]
    : [];

  try {
    for (let round = 0; round <= maxRounds; round++) {
      const { stopReason, assistant } = await provider.chatStream(
        { model, system: "", messages, tools, maxTokens: 8192, signal: controller.signal },
        () => {},
      );
      messages.push(assistant);

      if (stopReason !== "tool_use") {
        const text = assistant.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const parsed = extractJsonFromText(text);
        if (parsed === null) {
          throw new Error(`chatJsonWithSearch 无法从终局回复提取 JSON: ${text.slice(0, 200)}`);
        }
        return parsed as T;
      }

      // 内置搜索:本地无实现,arguments 逐字回填为 tool 消息,平台下一轮执行并注入结果
      const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      messages.push({
        role: "user",
        content: toolUses.map((tu) => ({
          type: "tool_result" as const,
          tool_use_id: tu.id,
          name: tu.name,
          content: tu.rawArguments ?? JSON.stringify(tu.input),
        })),
      });
    }
    throw new Error(`chatJsonWithSearch 超过 ${maxRounds} 轮搜索往返仍未收敛`);
  } finally {
    clearTimeout(timer);
  }
}
