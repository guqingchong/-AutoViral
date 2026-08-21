/**
 * chatJsonWithSearch 终局修复轮(2026-08-21 选题调研三平台失败根因):
 * kimi-for-coding 多轮搜索后终局回复常不是可提取 JSON ——
 * ① 叙述文本(英文/markdown 过程记录)② max_tokens 截断的半截 JSON。
 * 旧实现提取失败即抛错,12 轮搜索一次踏空全废。
 */
import { describe, it, expect } from "vitest";
import { chatJsonWithSearch } from "../../src/llm/search-json.js";
import type { ChatRequest, LlmProvider } from "../../src/llm/types.js";

function mockProvider(replies: Array<{ stopReason: string; text: string }>) {
  const calls: ChatRequest[] = [];
  const provider: LlmProvider = {
    name: "mock",
    protocol: "openai",
    async chatStream(req) {
      calls.push(JSON.parse(JSON.stringify(req)));
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      return {
        stopReason: r.stopReason,
        assistant: { role: "assistant" as const, content: [{ type: "text" as const, text: r.text }] },
      };
    },
    async chatJson() { return {} as never; },
  };
  return { provider, calls };
}

const VALID_JSON = `{"topics":[{"title":"城市更新与AI结合","heat":4}]}`;

describe("chatJsonWithSearch 终局修复轮", () => {
  it("叙述型终局(小红书形态)→ 修复轮后提取成功", async () => {
    const { provider, calls } = mockProvider([
      { stopReason: "end_turn", text: "I need to perform independent research on this topic..." },
      { stopReason: "end_turn", text: VALID_JSON },
    ]);
    const r = await chatJsonWithSearch<{ topics: unknown[] }>(provider, "m", "调研小红书趋势");
    expect(r.topics).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // 第二轮请求:assistant 叙述被回填,最后一条 user 消息是 JSON 输出纪律要求
    const lastUser = [...calls[1].messages].reverse().find((m) => m.role === "user");
    const text = (lastUser!.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toContain("JSON");
  });

  it("截断型终局(快手形态,stopReason=max_tokens)→ 修复轮提示精简后成功", async () => {
    const { provider, calls } = mockProvider([
      { stopReason: "max_tokens", text: `{"fetch_time": "2026-08-2` },
      { stopReason: "end_turn", text: VALID_JSON },
    ]);
    const r = await chatJsonWithSearch<{ topics: unknown[] }>(provider, "m", "调研快手趋势");
    expect(r.topics).toHaveLength(1);
    expect(calls).toHaveLength(2);
    const lastUser = [...calls[1].messages].reverse().find((m) => m.role === "user");
    const text = (lastUser!.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text").map((b) => b.text).join("");
    expect(text).toMatch(/截断|精简/);
  });

  it("修复轮用尽仍非 JSON → 抛错(含终局回复摘要),调用次数 = 1 + maxRepairs", async () => {
    const { provider, calls } = mockProvider([
      { stopReason: "end_turn", text: "# 1. 首次联网搜索已完成" },
      { stopReason: "end_turn", text: "我还是想继续解释" },
      { stopReason: "end_turn", text: "最后一次也不是 JSON" },
    ]);
    await expect(chatJsonWithSearch(provider, "m", "调研知乎趋势", { maxRepairs: 2 }))
      .rejects.toThrow(/无法从终局回复提取 JSON/);
    expect(calls).toHaveLength(3);
  });

  it("终局即合法 JSON 时不触发修复轮(回归)", async () => {
    const { provider, calls } = mockProvider([{ stopReason: "end_turn", text: VALID_JSON }]);
    const r = await chatJsonWithSearch<{ topics: unknown[] }>(provider, "m", "p");
    expect(r.topics).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
