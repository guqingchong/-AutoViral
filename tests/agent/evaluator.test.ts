import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvalResultText, resolveVision, runApiEvaluator } from "../../src/agent/evaluator.js";
import { _resetProviders } from "../../src/llm/registry.js";
import type { Config } from "../../src/config.js";

// P2-T1:评审 loop —— 解析共享/视觉路由/assets-assembly 无视觉模型报错

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function cfgWith(providers: Record<string, unknown>, models?: Record<string, string>): Config {
  return {
    port: 3271, model: "sonnet",
    jimeng: { accessKey: "", secretKey: "" },
    research: { enabled: false, schedule: "", platforms: [] },
    analytics: { enabled: false, collectInterval: 60, sources: [] },
    llm: { defaultProvider: "deepseek", providers: providers as never, models: models ?? { eval: "deepseek:deepseek-v4-pro" } },
  } as Config;
}

describe("parseEvalResultText", () => {
  it("```json 代码块优先", () => {
    const r = parseEvalResultText("前言\n```json\n{\"verdict\":\"fail\",\"issues\":[]}\n```\n后记", "plan");
    expect(r.verdict).toBe("fail");
  });
  it("全文 JSON", () => {
    expect(parseEvalResultText("{\"verdict\":\"pass\",\"scores\":{\"a\":9}}", "plan").scores.a).toBe(9);
  });
  it("无法解析 → 兜底 pass(与 CLI 路径语义一致)", () => {
    const r = parseEvalResultText("这不是 JSON", "assembly");
    expect(r.verdict).toBe("pass");
    expect(r.step).toBe("assembly");
  });
  it("无法解析 → 打 __parseFailed 标记(2026-08-19 堵假 pass 洞:调用方据此先重试)", () => {
    const bad = parseEvalResultText("这不是 JSON", "plan") as { __parseFailed?: boolean };
    expect(bad.__parseFailed).toBe(true);
    const good = parseEvalResultText("{\"verdict\":\"pass\"}", "plan") as { __parseFailed?: boolean };
    expect(good.__parseFailed).toBeUndefined();
  });
});

describe("resolveVision", () => {
  beforeEach(() => _resetProviders());
  const ds = { protocol: "openai", baseUrl: "https://ds.test/v1", apiKey: "k1" };
  const kimi = { protocol: "openai", baseUrl: "https://kimi.test/v1", apiKey: "k2" };
  const glm = { protocol: "openai", baseUrl: "https://glm.test/v4", apiKey: "k3", visionModel: "glm-4v" };

  it("评审 provider 自家 visionModel 优先", () => {
    const v = resolveVision(cfgWith({ deepseek: { ...ds, visionModel: "ds-vl" }, kimi, glm }), "deepseek");
    expect(v?.model).toBe("ds-vl");
    expect(v?.provider.name).toBe("deepseek");
  });
  it("deepseek 无视觉 → kimi(预设 visionModel=kimi-for-coding)优先于 glm", () => {
    const v = resolveVision(cfgWith({ deepseek: ds, kimi, glm }), "deepseek");
    expect(v?.provider.name).toBe("kimi");
    expect(v?.model).toBe("kimi-for-coding");
  });
  it("只有 glm → glm-4v 兜底", () => {
    const v = resolveVision(cfgWith({ deepseek: ds, glm }), "deepseek");
    expect(v?.model).toBe("glm-4v");
  });
  it("三家都没配 key → null(触发配置校验期报错)", () => {
    expect(resolveVision(cfgWith({ deepseek: ds }), "deepseek")).toBeNull();
  });
});

describe("runApiEvaluator", () => {
  // registry 的 provider 实例缓存按 key 跨测试存活——每个用例前必须清,否则别家用例的 key 漏进来
  beforeEach(() => _resetProviders());
  afterEach(() => vi.unstubAllGlobals());

  function sse(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const full = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    return new ReadableStream({ start(c) { c.enqueue(enc.encode(full)); c.close(); } });
  }

  function fakeBridgeSession(workId: string) {
    const session = { workId, messageHistory: [], browserSockets: new Set() } as never;
    const bridge = { pushBlock: vi.fn(), broadcastToBrowsers: vi.fn(), finalizeTurn: vi.fn() } as never;
    return { session, bridge };
  }

  it("assets 评审无视觉模型 → 配置校验期报错(不盲评)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-eval-"));
    const { session, bridge } = fakeBridgeSession("w1");
    await expect(runApiEvaluator({
      workId: "w1", step: "assets", evalPrompt: "评审素材", workDir: dir,
      config: cfgWith({ deepseek: { protocol: "openai", baseUrl: "https://ds.test/v1", apiKey: "k" } }),
      session, bridge,
    })).rejects.toThrow(/视觉模型/);
    await rm(dir, { recursive: true, force: true });
  });

  it("含图片回合路由 kimi,图片以 image_url 进请求,结论 JSON 解析返回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-eval-"));
    await writeFile(join(dir, "frame.png"), TINY_PNG);
    const urls: string[] = [];
    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: { body: string }) => {
      urls.push(url);
      bodies.push(init.body);
      if (urls.length === 1) {
        // 第一轮(deepseek):要求 Read 读图
        return new Response(sse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: JSON.stringify({ file_path: "frame.png" }) } }] } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]), { status: 200 });
      }
      // 第二轮(应路由 kimi 视觉):返回评审 JSON
      return new Response(sse([
        JSON.stringify({ choices: [{ delta: { content: "```json\n{\"verdict\":\"pass\",\"scores\":{\"构图\":9}}\n```" }, finish_reason: "stop" }] }),
      ]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { session, bridge } = fakeBridgeSession("w2");
    const result = await runApiEvaluator({
      workId: "w2", step: "assets", evalPrompt: "评审 assets 阶段产出", workDir: dir,
      config: cfgWith({
        deepseek: { protocol: "openai", baseUrl: "https://ds.test/v1", apiKey: "k1" },
        kimi: { protocol: "openai", baseUrl: "https://kimi.test/v1", apiKey: "k2" },
      }),
      session, bridge,
    });

    expect(result.verdict).toBe("pass");
    expect(urls[0]).toBe("https://ds.test/v1/chat/completions");
    // 图片回合 → kimi 视觉端点,且请求体带 image_url base64
    expect(urls[1]).toBe("https://kimi.test/v1/chat/completions");
    expect(bodies[1]).toContain("image_url");
    expect(bodies[1]).toContain("data:image/png;base64");
    expect(JSON.parse(bodies[1]).model).toBe("kimi-for-coding");
    await rm(dir, { recursive: true, force: true });
  });

  it("评审输出无法解析 → 自动要求重出一轮,采纳重出结果(2026-08-19 堵假 pass 洞)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-eval-"));
    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      if (bodies.length === 1) {
        // 首轮:话痨输出,无 JSON
        return new Response(sse([
          JSON.stringify({ choices: [{ delta: { content: "整体来看这个阶段的产出还是不错的,我觉得可以通过……" }, finish_reason: "stop" }] }),
        ]), { status: 200 });
      }
      // 重出轮:合规 JSON(fail)
      return new Response(sse([
        JSON.stringify({ choices: [{ delta: { content: "```json\n{\"verdict\":\"fail\",\"issues\":[{\"severity\":\"major\",\"description\":\"缺交付物\"}]}\n```" }, finish_reason: "stop" }] }),
      ]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { session, bridge } = fakeBridgeSession("w3");
    const result = await runApiEvaluator({
      workId: "w3", step: "plan", evalPrompt: "评审 plan 阶段产出", workDir: dir,
      config: cfgWith({ deepseek: { protocol: "openai", baseUrl: "https://ds.test/v1", apiKey: "k1" } }),
      session, bridge,
    });

    expect(bodies.length).toBe(2); // 首轮 + 重出轮
    expect(result.verdict).toBe("fail"); // 采纳重出结果,而非兜底 pass
    expect((result as { __parseFailed?: boolean }).__parseFailed).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("重出仍无法解析 → 抛 EvalParseError(2026-08-28 批次1.5:兜底 pass 放水通道已堵死)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-eval-"));
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(sse([
        JSON.stringify({ choices: [{ delta: { content: "就是不给 JSON,略略略" }, finish_reason: "stop" }] }),
      ]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { session, bridge } = fakeBridgeSession("w4");
    await expect(runApiEvaluator({
      workId: "w4", step: "plan", evalPrompt: "评审 plan 阶段产出", workDir: dir,
      config: cfgWith({ deepseek: { protocol: "openai", baseUrl: "https://ds.test/v1", apiKey: "k1" } }),
      session, bridge,
    })).rejects.toThrow("不再兜底 pass");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await rm(dir, { recursive: true, force: true });
  });
});
