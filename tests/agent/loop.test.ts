import { describe, it, expect } from "vitest";
import { AgentLoop, LoopGuardError, type LoopEvent } from "../../src/agent/loop.js";
import type { LlmProvider, ChatRequest, StreamEvent, AgentMessage } from "../../src/llm/types.js";

/** 可编程 mock provider：按脚本依次响应 */
function mockProvider(script: Array<(req: ChatRequest, emit: (e: StreamEvent) => void) => { stopReason: string; assistant: AgentMessage }>): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  let i = 0;
  return {
    name: "mock",
    protocol: "openai",
    calls,
    async chatStream(req, onEvent) {
      calls.push(JSON.parse(JSON.stringify(req))); // 快照——loop 的 messages 是活引用，事后会被继续 push
      const step = script[Math.min(i++, script.length - 1)];
      return step(req, onEvent);
    },
    async chatJson() { return {} as never; },
  };
}

const textReply = (text: string) => (req: ChatRequest, emit: (e: StreamEvent) => void) => {
  emit({ type: "text_delta", text });
  emit({ type: "message_stop", stopReason: "end_turn" });
  return { stopReason: "end_turn", assistant: { role: "assistant" as const, content: [{ type: "text" as const, text }] } };
};

const toolReply = (name: string, input: Record<string, unknown>, thenText: string) => [
  (req: ChatRequest, emit: (e: StreamEvent) => void) => {
    emit({ type: "message_stop", stopReason: "tool_use" });
    return {
      stopReason: "tool_use",
      assistant: { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name, input }] },
    };
  },
  textReply(thenText),
];

function fakeTools(record: Array<{ name: string; input: Record<string, unknown> }>) {
  return {
    Read: {
      def: { name: "Read", description: "d", input_schema: {} },
      async execute(input: Record<string, unknown>) {
        record.push({ name: "Read", input });
        return "文件内容";
      },
    },
  };
}

describe("AgentLoop", () => {
  it("纯文本回合：text_delta 流出 + resultText 拼接 + 消息入列", async () => {
    const provider = mockProvider([textReply("你好")]);
    const events: LoopEvent[] = [];
    const loop = new AgentLoop({
      provider, model: "m", systemPrompt: "sys", tools: {}, workDir: "/tmp",
      onLoopEvent: (e) => events.push(e),
    });
    const r = await loop.runTurn("打招呼");
    expect(r.resultText).toBe("你好");
    expect(events.some((e) => e.type === "text_delta" && e.text === "你好")).toBe(true);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(loop.messages).toHaveLength(2); // user + assistant
  });

  it("工具迭代回合：tool_use 执行→tool_result 回填→继续到文本结束", async () => {
    const provider = mockProvider(toolReply("Read", { file_path: "/a.txt" }, "读完了"));
    const record: Array<{ name: string; input: Record<string, unknown> }> = [];
    const loop = new AgentLoop({
      provider, model: "m", systemPrompt: "sys", tools: fakeTools(record) as never, workDir: "/tmp",
      onLoopEvent: () => {},
    });
    const r = await loop.runTurn("读文件");
    expect(r.resultText).toBe("读完了");
    expect(record).toEqual([{ name: "Read", input: { file_path: "/a.txt" } }]);
    // messages: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(loop.messages).toHaveLength(4);
    expect(provider.calls).toHaveLength(2);
  });

  it("AskUserQuestion：回合以 awaiting_user 结束，用户答案作为 tool_result 回填", async () => {
    const provider = mockProvider(toolReply("AskUserQuestion", { question: "选哪个？" }, "收到答案"));
    const events: LoopEvent[] = [];
    const loop = new AgentLoop({
      provider, model: "m", systemPrompt: "sys", tools: fakeTools([]) as never, workDir: "/tmp",
      onLoopEvent: (e) => events.push(e),
    });
    const r1 = await loop.runTurn("开始");
    expect(r1.stopReason).toBe("awaiting_user");
    expect(loop.pendingAskToolUseId).toBe("t1");

    const r2 = await loop.runTurn("选 A");
    expect(r2.resultText).toBe("收到答案");
    // 第二次调用的最后一条 messages 应是 tool_result 配对回填
    const secondCall = provider.calls[1];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "选 A" });
  });

  it("同工具同参 3 连触发守卫", async () => {
    const sameTool = toolReply("Read", { file_path: "/a" }, "x")[0];
    const provider = mockProvider([sameTool]);
    const loop = new AgentLoop({
      provider, model: "m", systemPrompt: "sys", tools: fakeTools([]) as never, workDir: "/tmp",
      onLoopEvent: () => {},
    });
    await expect(loop.runTurn("go")).rejects.toThrow(LoopGuardError);
  });

  it("abortTurn 中断回合", async () => {
    const provider = mockProvider([(req, emit) => {
      emit({ type: "message_stop", stopReason: "aborted" });
      return { stopReason: "aborted", assistant: { role: "assistant" as const, content: [] } };
    }]);
    const loop = new AgentLoop({
      provider, model: "m", systemPrompt: "sys", tools: {}, workDir: "/tmp",
      onLoopEvent: () => {},
    });
    loop.abortTurn();
    const r = await loop.runTurn("go");
    expect(r.stopReason).toBe("aborted");
  });
});
