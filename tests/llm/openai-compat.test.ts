import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAICompatProvider } from "../../src/llm/openai-compat.js";
import type { StreamEvent } from "../../src/llm/types.js";

/** 把 SSE 文本块编码为 ReadableStream（按给定切片大小分块，模拟跨 chunk 断行） */
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

function mockFetchOnce(body: ReadableStream<Uint8Array> | object, status = 200) {
  const stream = body instanceof ReadableStream
    ? body
    : new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          c.close();
        },
      });
  return vi.fn().mockResolvedValue(new Response(stream, { status }));
}

describe("OpenAICompatProvider.chatStream", () => {
  beforeEach(() => vi.stubGlobal("fetch", undefined));
  afterEach(() => vi.unstubAllGlobals());

  it("解析跨 chunk 断行的文本流 + stop + usage（含缓存命中）", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "你好" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "，世界" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 } }),
    ];
    vi.stubGlobal("fetch", mockFetchOnce(sseStream(chunks, 5)));

    const p = new OpenAICompatProvider("deepseek", { baseUrl: "https://x/v1", apiKey: "k" });
    const events: StreamEvent[] = [];
    const { stopReason, assistant } = await p.chatStream(
      { model: "m", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], maxTokens: 100 },
      (e) => events.push(e),
    );
    expect(stopReason).toBe("end_turn");
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as any).text).join("")).toBe("你好，世界");
    const usage = events.find((e) => e.type === "usage") as any;
    expect(usage.cacheReadTokens).toBe(80);
    expect(assistant.content[0]).toEqual({ type: "text", text: "你好，世界" });
  });

  it("流式 tool_calls 分片累积，完整后一次性发 tool_use", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{\"pa" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"/tmp/a.txt\"}" } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    vi.stubGlobal("fetch", mockFetchOnce(sseStream(chunks, 4)));

    const p = new OpenAICompatProvider("kimi", { baseUrl: "https://x/v1", apiKey: "k" });
    const events: StreamEvent[] = [];
    const { stopReason, assistant } = await p.chatStream(
      { model: "m", system: "s", messages: [], tools: [{ name: "Read", description: "d", input_schema: {} }], maxTokens: 100 },
      (e) => events.push(e),
    );
    expect(stopReason).toBe("tool_use");
    const tu = events.filter((e) => e.type === "tool_use");
    expect(tu).toHaveLength(1);
    expect((tu[0] as any).block).toMatchObject({ name: "Read", input: { path: "/tmp/a.txt" } });
    const assistantTools = assistant.content.filter((b) => b.type === "tool_use");
    expect(assistantTools).toHaveLength(1);
  });

  it("GLM reasoning_content 映射为 thinking_delta", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: "想一下" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "答案" }, finish_reason: "stop" }] }),
    ];
    vi.stubGlobal("fetch", mockFetchOnce(sseStream(chunks)));
    const p = new OpenAICompatProvider("glm", { baseUrl: "https://x/v1", apiKey: "k" });
    const events: StreamEvent[] = [];
    await p.chatStream({ model: "m", system: "s", messages: [], tools: [], maxTokens: 10 }, (e) => events.push(e));
    expect(events.some((e) => e.type === "thinking_delta" && (e as any).text === "想一下")).toBe(true);
  });

  it("400 不可重试（直抛），429 可重试", async () => {
    const f400 = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", f400);
    const p = new OpenAICompatProvider("deepseek", { baseUrl: "https://x/v1", apiKey: "k" });
    await expect(
      p.chatStream({ model: "m", system: "s", messages: [], tools: [], maxTokens: 10 }, () => {}),
    ).rejects.toThrow("400");
    expect(f400).toHaveBeenCalledTimes(1);

    let calls = 0;
    const f429 = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 2) return Promise.resolve(new Response("rate limit", { status: 429 }));
      return Promise.resolve(new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]), { status: 200 }));
    });
    vi.stubGlobal("fetch", f429);
    const r = await p.chatStream({ model: "m", system: "s", messages: [], tools: [], maxTokens: 10 }, () => {});
    expect(r.stopReason).toBe("end_turn");
    expect(f429).toHaveBeenCalledTimes(2);
  }, 20000);

  it("消息转换：tool_use/tool_result/image 三类块", async () => {
    let captured: any;
    const spy = vi.fn().mockImplementation((_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return Promise.resolve(new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })]), { status: 200 }));
    });
    vi.stubGlobal("fetch", spy);
    const p = new OpenAICompatProvider("deepseek", { baseUrl: "https://x/v1", apiKey: "k" });
    await p.chatStream({
      model: "m",
      system: "sys",
      messages: [
        { role: "assistant", content: [
          { type: "text", text: "我来看一下" },
          { type: "tool_use", id: "c1", name: "Read", input: { path: "/a" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "c1", content: "文件内容" },
        ] },
        { role: "user", content: [
          { type: "text", text: "看这图" },
          { type: "image", mediaType: "image/png", base64: "QUJD" },
        ] },
      ],
      tools: [],
      maxTokens: 10,
    }, () => {});
    expect(captured.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(captured.messages[1].tool_calls[0].function.name).toBe("Read");
    expect(captured.messages[1].tool_calls[0].function.arguments).toBe('{"path":"/a"}');
    expect(captured.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "文件内容" });
    expect(captured.messages[3].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  });

  it("passReasoningBack=true 时 assistant thinking 回填为 reasoning_content（Kimi thinking 模式）", async () => {
    let captured: any;
    const spy = vi.fn().mockImplementation((_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return Promise.resolve(new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })]), { status: 200 }));
    });
    vi.stubGlobal("fetch", spy);
    const p = new OpenAICompatProvider("kimi", { baseUrl: "https://x/v1", apiKey: "k", passReasoningBack: true });
    await p.chatStream({
      model: "m",
      system: "sys",
      messages: [
        { role: "assistant", content: [
          { type: "thinking", thinking: "先分析合规风险" },
          { type: "text", text: "结论" },
        ] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
      tools: [],
      maxTokens: 10,
    }, () => {});
    expect(captured.messages[1].reasoning_content).toBe("先分析合规风险");
    expect(captured.messages[1].content).toBe("结论");
  });

  it("passReasoningBack 缺省/false 时丢弃 thinking（不回填路径）", async () => {
    let captured: any;
    const spy = vi.fn().mockImplementation((_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return Promise.resolve(new Response(sseStream([JSON.stringify({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })]), { status: 200 }));
    });
    vi.stubGlobal("fetch", spy);
    const p = new OpenAICompatProvider("deepseek", { baseUrl: "https://x/v1", apiKey: "k" });
    await p.chatStream({
      model: "m",
      system: "sys",
      messages: [
        { role: "assistant", content: [
          { type: "thinking", thinking: "不应回填" },
          { type: "text", text: "结论" },
        ] },
      ],
      tools: [],
      maxTokens: 10,
    }, () => {});
    expect("reasoning_content" in captured.messages[1]).toBe(false);
  });
});
