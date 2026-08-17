import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

// P1-T7:GET /api/config llm 段掩码呈现 + PUT 合并语义 + /api/llm/ping + enabled 路由闸

const REAL_KEY = "sk-3d47ebf34d4b4c11bc6da6821f189b3a";

function cfgWithLlm(llm?: unknown) {
  return {
    port: 3271, model: "sonnet",
    jimeng: { accessKey: "", secretKey: "" },
    research: { enabled: false, schedule: "", platforms: [] },
    analytics: { enabled: false, collectInterval: 60, sources: [] },
    ...(llm ? { llm } : {}),
  };
}

const LLM_FULL = {
  defaultProvider: "deepseek",
  providers: {
    deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: REAL_KEY },
  },
  models: { plan: "deepseek:deepseek-v4-pro" },
};

describe("llm 设置(P1-T7)", () => {
  let dir: string;
  let apiRoutes: any;

  async function boot(configObj: unknown) {
    dir = await mkdtemp(join(tmpdir(), "av-api-llm-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    await writeFile(join(dir, "config.yaml"), yaml.dump(configObj), "utf-8");
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    ({ apiRoutes } = await import("../../src/server/api.js"));
  }

  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function putLlm(llm: unknown) {
    return apiRoutes.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm }),
    });
  }

  async function savedLlm(): Promise<any> {
    return (yaml.load(await readFile(join(dir, "config.yaml"), "utf-8")) as any).llm;
  }

  it("GET 返回三家预设(未配置也给默认 baseUrl),apiKey 掩码不出明文", async () => {
    await boot(cfgWithLlm(LLM_FULL));
    const data = await (await apiRoutes.request("/api/config")).json();
    const p = data.llm.providers;
    expect(Object.keys(p)).toEqual(expect.arrayContaining(["deepseek", "kimi", "glm"]));
    expect(p.deepseek.apiKey).toContain("***");
    expect(JSON.stringify(data)).not.toContain(REAL_KEY);
    expect(p.kimi.baseUrl).toBe("https://api.kimi.com/coding/v1");  // 预设补全
    expect(p.kimi.enabled).toBe(true);
    expect(data.llm.models.plan).toBe("deepseek:deepseek-v4-pro");
  });

  it("GET 无 llm 配置时三家卡片仍出现、key 为空", async () => {
    await boot(cfgWithLlm(undefined));
    const data = await (await apiRoutes.request("/api/config")).json();
    expect(data.llm.providers.deepseek.apiKey).toBe("");
    expect(data.llm.providers.glm.visionModel).toBe("glm-4v");
  });

  it("PUT 掩码 key 保留原值;新 key 覆盖;其余 llm 字段不动", async () => {
    await boot(cfgWithLlm(LLM_FULL));
    const masked = (await (await apiRoutes.request("/api/config")).json()).llm.providers.deepseek.apiKey;
    const res = await putLlm({
      providers: {
        deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: masked, visionModel: "", enabled: true },
        kimi: { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-newkey123456", visionModel: "kimi-for-coding", enabled: false },
      },
    });
    expect(res.status).toBe(200);
    const saved = await savedLlm();
    expect(saved.providers.deepseek.apiKey).toBe(REAL_KEY);            // 掩码 → 保留
    expect(saved.providers.kimi.apiKey).toBe("sk-kimi-newkey123456");    // 新值 → 覆盖
    expect(saved.providers.kimi.enabled).toBe(false);
    expect(saved.models.plan).toBe("deepseek:deepseek-v4-pro");          // 未提交 → 保留
    // PUT 响应同样不出明文
    expect(JSON.stringify(await res.json?.() ?? {})).not.toContain("sk-kimi-newkey123456");
  });

  it("PUT 空串 apiKey 视为显式清除", async () => {
    await boot(cfgWithLlm(LLM_FULL));
    await putLlm({ providers: { deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", visionModel: "", enabled: true } } });
    expect((await savedLlm()).providers.deepseek.apiKey).toBe("");
  });

  it("POST /api/llm/ping 用保存的 key 打 models 列表,返回延迟", async () => {
    await boot(cfgWithLlm(LLM_FULL));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await apiRoutes.request("/api/llm/ping", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.models).toBe(1);
    expect(typeof data.latencyMs).toBe("number");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/models");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${REAL_KEY}`);
  });

  it("POST /api/llm/ping 掩码 key 回落到已保存值;无 key 报 400", async () => {
    await boot(cfgWithLlm(LLM_FULL));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const res = await apiRoutes.request("/api/llm/ping", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", apiKey: "sk-3d***b3a" }),
    });
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("401");

    await boot(cfgWithLlm({ providers: { deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "" } } }));
    const res2 = await apiRoutes.request("/api/llm/ping", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });
    expect(res2.status).toBe(400);
  });

  it("enabled=false 的 provider 路由期抛可读错误", async () => {
    await boot(cfgWithLlm({
      providers: { deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: REAL_KEY, enabled: false } },
    }));
    const { getProvider, _resetProviders } = await import("../../src/llm/registry.js");
    _resetProviders();
    const { loadConfig } = await import("../../src/config.js");
    const config = await loadConfig();
    expect(() => getProvider(config, "deepseek")).toThrow(/停用/);
  });
});
