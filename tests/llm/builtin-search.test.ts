import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/llm/openai-compat.js";
import { AgentLoop } from "../../src/agent/loop.js";
import type { AgentMessage, ChatRequest, LlmProvider, StreamEvent, ToolUseBlock } from "../../src/llm/types.js";

// Kimi $web_search 两段协议(2026-08-17 实测 api.kimi.com/coding):
// ① 模型返回 builtin_function tool_call(arguments 内含 search_id)
// ② 客户端逐字回填 assistant tool_calls + tool 消息 → 平台执行搜索并注入结果

function sseStream(chunks: string[], sliceSize = 7): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const full = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < full.length; i += sliceSize) {
        controller.enqueue(encoder.encode(full.slice(i, i + sliceSize)));
      }
      controller.close();
    },
  });
}

const SEARCH_ARGS = '{"search_result":{"search_id":"sid-1"},"usage":{"total_tokens":100}}';

function builtinSse(): ReadableStream<Uint8Array> {
  return sseStream([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "tool_1", type: "builtin_function", function: { name: "$web_search", arguments: SEARCH_ARGS } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
  ]);
}

describe("builtin_function(Kimi $web_search)协议", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builtin ToolDef 映射为 builtin_function;响应块带 builtin+rawArguments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(builtinSse(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const p = new OpenAICompatProvider("kimi", { baseUrl: "https://x/v1", apiKey: "k" });
    const events: StreamEvent[] = [];
    const { stopReason, assistant } = await p.chatStream(
      {
        model: "kimi-for-coding", system: "s", messages: [], maxTokens: 100,
        tools: [{ name: "$web_search", builtin: true, description: "d", input_schema: {} }],
      },
      (e) => events.push(e),
    );

    // 请求侧:builtin_function 透传
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.tools).toEqual([{ type: "builtin_function", function: { name: "$web_search" } }]);

    // 响应侧:块带 builtin 标记与逐字 arguments
    expect(stopReason).toBe("tool_use");
    const block = events.find((e) => e.type === "tool_use") as { block: ToolUseBlock };
    expect(block.block.builtin).toBe(true);
    expect(block.block.rawArguments).toBe(SEARCH_ARGS);
    const assistantTu = assistant.content.find((b) => b.type === "tool_use") as ToolUseBlock;
    expect(assistantTu.builtin).toBe(true);
    expect(assistantTu.rawArguments).toBe(SEARCH_ARGS);
  });

  it("回填序列化:assistant tool_calls 保持 builtin_function+逐字 arguments,tool 消息带 name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "搜索完成" }, finish_reason: "stop" }] })]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "$web_search", input: JSON.parse(SEARCH_ARGS), builtin: true, rawArguments: SEARCH_ARGS }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", name: "$web_search", content: SEARCH_ARGS }] },
    ];
    const p = new OpenAICompatProvider("kimi", { baseUrl: "https://x/v1", apiKey: "k" });
    // 本会话仍挂载该内置工具 → 保持 builtin_function
    await p.chatStream({ model: "m", system: "s", messages, tools: [{ name: "$web_search", builtin: true, description: "d", input_schema: {} }], maxTokens: 100 }, () => {});

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantMsg = sent.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.tool_calls[0].type).toBe("builtin_function");
    expect(assistantMsg.tool_calls[0].function.arguments).toBe(SEARCH_ARGS);
    const toolMsg = sent.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.name).toBe("$web_search");
    expect(toolMsg.content).toBe(SEARCH_ARGS);
  });

  it("跨 provider 恢复:当前请求未挂载内置工具时 builtin 降级为 function(deepseek 方言不接受 builtin_function)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "继续" }, finish_reason: "stop" }] })]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const messages: AgentMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "$web_search", input: JSON.parse(SEARCH_ARGS), builtin: true, rawArguments: SEARCH_ARGS }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", name: "$web_search", content: SEARCH_ARGS }] },
    ];
    const p = new OpenAICompatProvider("deepseek", { baseUrl: "https://x/v1", apiKey: "k" });
    await p.chatStream({ model: "deepseek-v4-pro", system: "s", messages, tools: [], maxTokens: 100 }, () => {});

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantMsg = sent.messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.tool_calls[0].type).toBe("function");
  });

  it("loop:builtin 工具不本地执行,arguments 逐字回填后继续回合", async () => {
    const calls: ChatRequest[] = [];
    const provider: LlmProvider = {
      name: "mock", protocol: "openai",
      async chatStream(req, onEvent) {
        calls.push(JSON.parse(JSON.stringify(req)));
        if (calls.length === 1) {
          onEvent({ type: "message_stop", stopReason: "tool_use" });
          return {
            stopReason: "tool_use",
            assistant: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tool_1", name: "$web_search", input: JSON.parse(SEARCH_ARGS), builtin: true, rawArguments: SEARCH_ARGS }],
            },
          };
        }
        onEvent({ type: "text_delta", text: "热搜是……" });
        onEvent({ type: "message_stop", stopReason: "end_turn" });
        return { stopReason: "end_turn", assistant: { role: "assistant", content: [{ type: "text", text: "热搜是……" }] } };
      },
      async chatJson() { return {} as never; },
    };

    let executed = false;
    const loop = new AgentLoop({
      provider, model: "kimi-for-coding", systemPrompt: "s",
      tools: {
        // 同名本地执行器也不应被调用(builtin 优先)
        $web_search: { def: { name: "$web_search", description: "d", input_schema: {} }, async execute() { executed = true; return "x"; } },
      } as never,
      builtinTools: [{ name: "$web_search", builtin: true, description: "联网搜索", input_schema: { type: "object", properties: {} } }],
      workDir: "/tmp",
      onLoopEvent: () => {},
    });

    const r = await loop.runTurn("搜一下本周抖音热点");
    expect(r.resultText).toBe("热搜是……");
    expect(executed).toBe(false);
    expect(calls).toHaveLength(2);
    // 第二轮请求:builtin def 仍在工具表,回填消息逐字携带 arguments
    expect(calls[0].tools.some((t) => t.name === "$web_search" && t.builtin)).toBe(true);
    const echo = calls[1].messages.find((m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"));
    const tr = echo?.content.find((b) => b.type === "tool_result");
    expect(tr).toMatchObject({ tool_use_id: "tool_1", name: "$web_search", content: SEARCH_ARGS });
  });
});
