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
  /** 记账阶段(2026-08-19 P1):默认 research;失败也记(tokens 已燃烧) */
  usageStage?: string;
  /** 终局非 JSON/被截断时的修复轮上限(2026-08-21 三平台调研失败根因),默认 2 */
  maxRepairs?: number;
}

export async function chatJsonWithSearch<T>(
  provider: LlmProvider,
  model: string,
  prompt: string,
  opts: SearchJsonOptions = {},
): Promise<T> {
  const maxRounds = opts.maxRounds ?? 8;
  // 2026-08-19 P1(sell_products "terminated" 根因):全局 8min 硬腰斩改为
  // 「每轮独立超时」——单轮(含搜索往返)给 4min,轮数由 maxRounds 控;
  // 且每轮失败可重试 2 次(指数退避),长终局 JSON 被截不再前功尽弃。
  const perRoundMs = Math.min(opts.timeoutMs ?? 4 * 60_000, 8 * 60_000);

  // 多轮 token 累计(2026-08-19 P1 直连记账)
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const onEvent = (ev: unknown) => {
    const e = ev as { type?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    if (e?.type === "usage") {
      acc.inputTokens += e.inputTokens ?? 0;
      acc.outputTokens += e.outputTokens ?? 0;
      acc.cacheReadTokens += e.cacheReadTokens ?? 0;
    }
  };

  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: prompt + JSON_OUTPUT_DISCIPLINE }] },
  ];
  const tools = opts.builtinSearchTool
    ? [{ name: opts.builtinSearchTool, description: "联网搜索", input_schema: { type: "object" }, builtin: true }]
    : [];

  try {
    let repairs = 0;
    const maxRepairs = opts.maxRepairs ?? 2;
    // round 预算 = 搜索往返 maxRounds + 已用修复轮 repairs(修复不消耗搜索预算)
    for (let round = 0; round <= maxRounds + repairs; round++) {
      // 单轮调用:独立 AbortController + 最多 3 次尝试(断流/超时重试)
      let stopReason = "";
      let assistant: AgentMessage | undefined;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3 && !assistant; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perRoundMs);
        try {
          const r = await provider.chatStream(
            { model, system: "", messages, tools, maxTokens: 8192, signal: controller.signal },
            onEvent,
          );
          stopReason = r.stopReason;
          assistant = r.assistant;
        } catch (err) {
          lastErr = err;
          if (attempt < 3) await new Promise((res) => setTimeout(res, 3000 * attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      if (!assistant) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      }
      messages.push(assistant);

      if (stopReason !== "tool_use") {
        const text = assistant.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const parsed = extractJsonFromText(text);
        if (parsed !== null) return parsed as T;
        // 2026-08-21 根因修复:kimi-for-coding 多轮搜索后终局常非 JSON
        // (叙述文本)或被 max_tokens 截断(半截 JSON)——旧实现一次踏空整平台失败。
        // 给模型修复轮:回填其回复 + 针对性输出纪律,重新生成。
        if (repairs < maxRepairs) {
          repairs++;
          const repairText = stopReason === "max_tokens"
            ? "你的上一条回复因长度限制被截断,不是完整的 JSON。请重新输出:条目数量可适当精简,每个字段的文字从简,直接输出完整的 JSON 对象,不要 markdown 围栏,不要任何解释文字。"
            : "你的上一条回复不是可解析的 JSON。请直接输出符合前文格式要求的 JSON 对象:不要 markdown 围栏,不要解释文字,不要调用任何工具。";
          messages.push({ role: "user", content: [{ type: "text", text: repairText }] });
          continue;
        }
        const truncHint = stopReason === "max_tokens" ? "(输出被 max_tokens 截断)" : "";
        throw new Error(`chatJsonWithSearch 无法从终局回复提取 JSON${truncHint}(已修复重试 ${repairs} 次): ${text.slice(0, 200)}`);
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
    if (acc.inputTokens > 0 || acc.outputTokens > 0) {
      const { recordUsageAsync } = await import("../services/llm-usage.js");
      recordUsageAsync({ stage: opts.usageStage ?? "research", provider: provider.name, model, ...acc });
    }
  }
}
