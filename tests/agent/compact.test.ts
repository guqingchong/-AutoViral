import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, maybeCompact } from "../../src/agent/compact.js";
import { AgentLoop } from "../../src/agent/loop.js";
import type { AgentMessage, ChatRequest, LlmProvider, StreamEvent } from "../../src/llm/types.js";

// P2-T2:结构压缩 —— 估算/阈值/配对边界/steps 注入/loop 集成

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] });
const toolCall = (id: string, name = "Bash"): AgentMessage => ({
  role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "ls" } }],
});
const toolResult = (id: string): AgentMessage => ({
  role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

describe("estimateTokens", () => {
  it("CJK 权重高于 ascii", () => {
    const cjk = estimateTokens([user("中".repeat(100))]);
    const ascii = estimateTokens([user("a".repeat(100))]);
    expect(cjk).toBeGreaterThan(ascii);
    expect(cjk).toBeCloseTo(60, 0);
    expect(ascii).toBeCloseTo(25, 0);
  });
});

describe("maybeCompact", () => {
  it("未超阈值原样返回", async () => {
    const msgs = [user("a"), assistant("b")];
    const r = await maybeCompact(msgs, { threshold: 1000 });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it("超阈值:留 messages[0]+最近 8 条,中段换摘要", async () => {
    const msgs: AgentMessage[] = [user("初始指令")];
    for (let i = 0; i < 20; i++) msgs.push(assistant(`阶段结论${i}:完成了一些工作`), user(`反馈${i}`));
    const r = await maybeCompact(msgs, { threshold: 100 });
    expect(r.compacted).toBe(true);
    expect(r.messages[0]).toEqual(user("初始指令"));
    expect(r.messages.length).toBe(10); // 1 + 摘要 + 8
    expect(JSON.stringify(r.messages[1])).toContain("上下文压缩");
    expect(JSON.stringify(r.messages[1])).toContain("阶段结论");
    expect(r.messages.at(-1)).toEqual(msgs.at(-1));
  });

  it("切口不劈开 tool_use/tool_result 配对", async () => {
    const msgs: AgentMessage[] = [user("初始")];
    for (let i = 0; i < 6; i++) msgs.push(assistant(`结论${i}`), user(`反馈${i}`));
    // 尾部 8 条的第 1 条恰好是 tool_result → 切口必须后移到其 assistant tool_use
    msgs.push(toolCall("t1"), toolResult("t1"), assistant("收尾"), user("最后"));
    const r = await maybeCompact(msgs, { threshold: 10 });
    expect(r.compacted).toBe(true);
    const tail = r.messages.slice(2);
    // 保留段首条不得是孤儿 tool_result
    const first = tail[0];
    const isOrphanResult = first.role === "user" && first.content.some((b) => b.type === "tool_result");
    expect(isOrphanResult).toBe(false);
    // 且每个 tool_result 都能在保留段内找到配对的 tool_use
    const useIds = new Set(tail.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)));
    for (const m of tail) {
      for (const b of m.content) {
        if (b.type === "tool_result") expect(useIds.has(b.tool_use_id)).toBe(true);
      }
    }
  });

  it("注入 workDir/steps/*.json 阶段摘要", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-compact-"));
    await mkdir(join(dir, "steps"), { recursive: true });
    await writeFile(join(dir, "steps", "research.json"), JSON.stringify({ step: "research", summary: "调研完成:3 个选题" }), "utf-8");
    const msgs: AgentMessage[] = [user("初始")];
    for (let i = 0; i < 15; i++) msgs.push(assistant(`工作${i}`), user(`继续${i}`));
    const r = await maybeCompact(msgs, { threshold: 10, workDir: dir });
    expect(JSON.stringify(r.messages[1])).toContain("调研完成:3 个选题");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("loop 集成", () => {
  it("超阈值回合请求前发生压缩", async () => {
    const calls: ChatRequest[] = [];
    const provider: LlmProvider = {
      name: "mock", protocol: "openai",
      async chatStream(req, onEvent) {
        calls.push(JSON.parse(JSON.stringify(req)));
        onEvent({ type: "text_delta", text: "好" });
        onEvent({ type: "message_stop", stopReason: "end_turn" });
        return { stopReason: "end_turn", assistant: { role: "assistant", content: [{ type: "text", text: "好" }] } };
      },
      async chatJson() { return {} as never; },
    };
    // 预置超长历史(经构造函数 restored 参数)
    const history: AgentMessage[] = [user("初始指令")];
    for (let i = 0; i < 15; i++) history.push(assistant(`历史结论${i}`), user(`历史反馈${i}`));
    const loop = new AgentLoop(
      { provider, model: "m", systemPrompt: "s", tools: {}, workDir: "/tmp", onLoopEvent: () => {}, compactThreshold: 10 },
      history,
    );
    await loop.runTurn("新消息");
    const sent = calls[0].messages;
    expect(sent.length).toBeLessThan(history.length + 1);
    expect(JSON.stringify(sent[1])).toContain("上下文压缩");
  });
});
