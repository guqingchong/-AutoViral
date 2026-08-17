import { describe, it, expect, vi } from "vitest";
import { withRetry, noRetry } from "../../src/llm/retry.js";
import { resolveModelFor, getProvider, _resetProviders } from "../../src/llm/registry.js";
import type { Config } from "../../src/config.js";

function cfg(llm: Config["llm"]): Config {
  return { port: 3271, model: "sonnet", jimeng: { accessKey: "", secretKey: "" }, research: { enabled: false, schedule: "", platforms: [] }, analytics: { enabled: false, collectInterval: 60, sources: [] }, llm } as Config;
}

describe("withRetry", () => {
  it("成功即返回；noRetry 直抛；可重试错误按次数重试", async () => {
    expect(await withRetry(async () => 42)).toBe(42);

    const hard = noRetry(new Error("400 bad"));
    let n = 0;
    await expect(withRetry(async () => { n++; throw hard; })).rejects.toThrow("400");
    expect(n).toBe(1);

    let m = 0;
    const r = await withRetry(async () => { m++; if (m < 3) throw new Error("429"); return "ok"; }, { backoffs: [1, 1, 1] });
    expect(r).toBe("ok");
    expect(m).toBe(3);
  });
});

describe("registry", () => {
  it("裸模型名走 defaultProvider；带前缀跨 provider；缺 key 报可读错误", () => {
    _resetProviders();
    const c = cfg({
      defaultProvider: "deepseek",
      providers: {
        deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "ds-key" },
        kimi: { protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", apiKey: "kimi-key" },
      },
      models: { plan: "deepseek-v4-pro", eval: "kimi:kimi-k2" },
    });
    const plan = resolveModelFor(c, "plan");
    expect(plan.provider.name).toBe("deepseek");
    expect(plan.model).toBe("deepseek-v4-pro");
    const ev = resolveModelFor(c, "eval");
    expect(ev.provider.name).toBe("kimi");
    expect(ev.model).toBe("kimi-k2");

    const noKey = cfg({ providers: { deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "" } } });
    _resetProviders(); // 清掉上半段缓存的带 key 实例
    expect(() => getProvider(noKey, "deepseek")).toThrow(/apiKey/);
  });
});
