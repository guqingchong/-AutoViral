/**
 * Kimi $web_search 两段协议 live 探针（2026-08-17 P1 验收项⑥）。
 * 走我们自己的 OpenAICompatProvider + 与 AgentLoop 相同的回填逻辑,验证:
 * 第一轮拿到 builtin_function 工具调用 → 逐字回填 → 第二轮平台注入真实搜索结果。
 * 用法: node --experimental-strip-types scripts/kimi-search-probe.ts
 */
import { loadConfig } from "../dist/config.js";
import { getProvider } from "../dist/llm/registry.js";
import type { AgentMessage, ToolUseBlock } from "../dist/llm/types.js";

const config = await loadConfig();
const provider = getProvider(config, "kimi");
const tools = [{ name: "$web_search", builtin: true, description: "联网搜索(平台服务端执行)", input_schema: { type: "object", properties: {} } }];

const question = process.argv[2] ?? "本周抖音热点话题";
const messages: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: `你可以使用 $web_search 工具联网搜索。请先用它搜索「${question}」,然后列出 3 条搜索到的结果标题。今天是 2026-08-17,涉及时效性必须搜索,禁止凭记忆回答。` }] },
];

// 第一轮:期待 builtin 工具调用
const r1 = await provider.chatStream(
  { model: "kimi-for-coding", system: "你是热点调研助手。", messages, tools: tools as never, maxTokens: 4000 },
  () => {},
);
const tu = r1.assistant.content.find((b): b is ToolUseBlock => b.type === "tool_use");
console.log("round1 stopReason:", r1.stopReason, "| tool:", tu?.name, "| builtin:", tu?.builtin);
if (!tu?.builtin || !tu.rawArguments) {
  console.log("FAIL: 未获得 builtin 工具调用");
  process.exit(1);
}

// 第二轮:与 AgentLoop 相同的逐字回填
messages.push(r1.assistant);
messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, name: tu.name, content: tu.rawArguments }] });

let text = "";
let usage: { inputTokens: number; outputTokens: number } | undefined;
const r2 = await provider.chatStream(
  { model: "kimi-for-coding", system: "你是热点调研助手。", messages, tools: tools as never, maxTokens: 4000 },
  (ev) => {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "usage") usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
  },
);
console.log("round2 stopReason:", r2.stopReason, "| usage:", JSON.stringify(usage));
console.log("---- 回答前 500 字 ----");
console.log(text.slice(0, 500));
if ((usage?.inputTokens ?? 0) < 1000) {
  console.log("WARN: inputTokens 未显著增长,搜索结果可能未注入");
  process.exit(1);
}
console.log("OK: 搜索结果已注入(inputTokens 显著增长),两段协议经自有 provider 栈跑通");
