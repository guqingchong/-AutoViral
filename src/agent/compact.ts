/**
 * 上下文结构压缩(2026-08-17 LLM 直连架构 P2-T2)。
 * 设计文档:docs/desigen/02 P2-T2
 *
 * - estimateTokens:确定性估算(CJK×0.6 + 其他×0.25),不调用 tiktoken
 * - maybeCompact:超阈值时把中段消息换成确定性摘要(不耗 LLM),
 *   保留 messages[0](初始指令)+最近 8 条;切口对齐 tool_use/tool_result 配对边界
 *   (劈开配对 → OpenAI 400);并从 workDir/steps/<step>.json 注入阶段摘要
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage, ContentBlock, TextBlock, ToolResultBlock, ToolUseBlock } from "../llm/types.js";

const DEFAULT_THRESHOLD = 120_000;
const KEEP_TAIL = 8;

function estimateTextTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return cjk * 0.6 + (s.length - cjk) * 0.25;
}

function estimateBlockTokens(b: ContentBlock): number {
  switch (b.type) {
    case "text": return estimateTextTokens(b.text);
    case "thinking": return estimateTextTokens(b.thinking);
    case "tool_use": return estimateTextTokens(JSON.stringify(b.input));
    case "tool_result":
      return typeof b.content === "string"
        ? estimateTextTokens(b.content)
        : b.content.reduce((n, x) => n + estimateBlockTokens(x), 0);
    case "image": return 1100; // 视觉 token 粗值(1120 量级),base64 字符不计
  }
}

export function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.reduce((n, b) => n + estimateBlockTokens(b), 0), 0);
}

/** 中段消息的确定性摘要:用户指令、工具使用统计、写过的文件、assistant 结论片段 */
function summarizeMiddle(middle: AgentMessage[]): string {
  const userTexts: string[] = [];
  const toolCounts = new Map<string, number>();
  const filesWritten = new Set<string>();
  const assistantConclusions: string[] = [];

  for (const m of middle) {
    for (const b of m.content) {
      if (m.role === "user" && b.type === "text") {
        userTexts.push(b.text.slice(0, 200));
      } else if (b.type === "tool_use") {
        toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1);
        const p = (b.input as Record<string, unknown>).file_path ?? (b.input as Record<string, unknown>).path;
        if ((b.name === "Write" || b.name === "Edit") && typeof p === "string") filesWritten.add(p);
      }
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
      if (text.trim()) assistantConclusions.push(text.slice(0, 300));
    }
  }

  const toolStat = [...toolCounts.entries()].map(([n, c]) => `${n}×${c}`).join(", ");
  const lines = [
    `【上下文压缩:以下为早期对话的确定性摘要,原 ${middle.length} 条消息已省略】`,
    userTexts.length ? `用户指令历史(截断):\n${userTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "",
    toolStat ? `已执行工具: ${toolStat}` : "",
    filesWritten.size ? `已写文件:\n${[...filesWritten].join("\n")}` : "",
    assistantConclusions.length
      ? `assistant 阶段结论(每段截断):\n${assistantConclusions.slice(-6).map((t, i) => `${i + 1}. ${t}`).join("\n")}`
      : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** workDir/steps/*.json 阶段摘要注入(流水线已完成阶段的结构化沉淀) */
async function loadStepSummaries(workDir: string): Promise<string> {
  try {
    const dir = join(workDir, "steps");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const parts: string[] = [];
    for (const f of files.sort()) {
      try {
        const raw = JSON.parse(await readFile(join(dir, f), "utf-8"));
        parts.push(`[steps/${f}]\n${JSON.stringify(raw).slice(0, 1500)}`);
      } catch { /* 单个损坏不阻断 */ }
    }
    return parts.length ? `【已完成阶段摘要】\n${parts.join("\n\n")}` : "";
  } catch {
    return ""; // 无 steps 目录
  }
}

/** 切口对齐:tool_result 打头的保留段会把配对劈开,向后扩到其 assistant tool_use 所在消息 */
function alignCutBoundary(messages: AgentMessage[], cut: number): number {
  const hasToolResult = (m: AgentMessage) => m.content.some((b): b is ToolResultBlock => b.type === "tool_result");
  const hasToolUse = (m: AgentMessage) => m.content.some((b): b is ToolUseBlock => b.type === "tool_use");
  let i = cut;
  while (i > 1 && hasToolResult(messages[i]) && !hasToolUse(messages[i])) {
    i--; // tool_result 的用户消息 → 必须带上前一条 assistant(tool_use)
  }
  // 同理:切口前一条若是带 tool_use 的 assistant,而切口条不含其 result,也把这条 assistant 并入摘要侧不安全——
  // 直接扩保留段更稳(上面循环已覆盖);此处再兜:切口条含 tool_use 的 assistant 不可能(tool_use 只在 assistant)
  return i;
}

export interface CompactResult {
  messages: AgentMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 超阈值则压缩:messages[0] + [压缩摘要+阶段摘要] + 最近 KEEP_TAIL 条。
 * 返回新数组,不改原引用。消息太少(<KEEP_TAIL+3)或估算未超阈值时原样返回。
 */
export async function maybeCompact(
  messages: AgentMessage[],
  opts: { threshold?: number; workDir?: string } = {},
): Promise<CompactResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const before = estimateTokens(messages);
  if (before <= threshold || messages.length < KEEP_TAIL + 3) {
    return { messages, compacted: false, beforeTokens: before, afterTokens: before };
  }

  const cut = alignCutBoundary(messages, messages.length - KEEP_TAIL);
  if (cut <= 1) return { messages, compacted: false, beforeTokens: before, afterTokens: before };

  const middle = messages.slice(1, cut);
  const summary = summarizeMiddle(middle);
  const stepSummaries = opts.workDir ? await loadStepSummaries(opts.workDir) : "";
  const summaryMsg: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: [summary, stepSummaries].filter(Boolean).join("\n\n") }],
  };

  const compacted = [messages[0], summaryMsg, ...messages.slice(cut)];
  const after = estimateTokens(compacted);
  console.log(`[compact] ${messages.length} 条 ${Math.round(before / 1000)}k → ${compacted.length} 条 ${Math.round(after / 1000)}k tokens(估算)`);
  return { messages: compacted, compacted: true, beforeTokens: before, afterTokens: after };
}
