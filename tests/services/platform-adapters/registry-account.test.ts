/**
 * Task 7: adapter 工厂化 + 按账号实例缓存 + 爬虫 contextKey/画像目录按账号隔离。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import {
  registerAdapter,
  registerAdapterFactory,
  getAdapter,
  getAdapterForAccount,
  listPlatforms,
  listAdapters,
  clearRegistry,
} from "../../../src/services/platform-adapters/registry.js";
import type { PlatformAdapter, CollectedMetrics, CollectedComment, ReplyResult } from "../../../src/services/platform-adapters/types.js";
import { DouyinScraper } from "../../../src/services/platform-adapters/douyin-scraper.js";
import { XiaohongshuScraper } from "../../../src/services/platform-adapters/xiaohongshu-scraper.js";
import { resolveProfileDir, PROFILE_DIR } from "../../../src/services/platform-adapters/playwright-helper.js";
import { resetInMemoryDb, closeDb, getDb } from "../../../src/db/connection.js";
import { migrate } from "../../../src/db/migrate.js";
import { setAccountCredential } from "../../../src/db/account-credentials-repo.js";
import { KuaishouAdapter } from "../../../src/services/platform-adapters/kuaishou-api.js";
import { ZhihuAdapter } from "../../../src/services/platform-adapters/zhihu-api.js";

class MockAdapter implements PlatformAdapter {
  readonly platform = "mock";
  readonly label = "Mock";
  constructor(readonly accountId?: string) {}
  async collectAccountMetrics(): Promise<CollectedMetrics> {
    return { collectedAt: new Date().toISOString(), rawData: {} };
  }
  async collectPostMetrics(): Promise<CollectedMetrics> {
    return { collectedAt: new Date().toISOString(), rawData: {} };
  }
  async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    return { comments: [] };
  }
  async publishReply(): Promise<ReplyResult> {
    return { success: true };
  }
}

describe("registry 工厂化 + 按账号实例", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("① 注册工厂后不同 accountId 返回不同实例", () => {
    registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId));
    const a1 = getAdapterForAccount("mock", "a1");
    const a2 = getAdapterForAccount("mock", "a2");
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1).not.toBe(a2);
    expect((a1 as MockAdapter).accountId).toBe("a1");
    expect((a2 as MockAdapter).accountId).toBe("a2");
  });

  it("② 同参数返回同一缓存实例", () => {
    registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId));
    expect(getAdapterForAccount("mock", "a1")).toBe(getAdapterForAccount("mock", "a1"));
    expect(getAdapterForAccount("mock")).toBe(getAdapterForAccount("mock", undefined));
    expect(getAdapterForAccount("mock")).not.toBe(getAdapterForAccount("mock", "a1"));
  });

  it("getAdapter(platform) 兼容旧调用 = getAdapterForAccount(platform, undefined)", () => {
    registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId));
    expect(getAdapter("mock")).toBe(getAdapterForAccount("mock", undefined));
    expect(getAdapter("unknown")).toBeUndefined();
  });

  it("旧 registerAdapter 直注册路径不受工厂化影响", () => {
    const legacy = new MockAdapter();
    registerAdapter(legacy);
    expect(getAdapter("mock")).toBe(legacy);
    expect(getAdapterForAccount("mock", "a1")).toBe(legacy); // 无工厂时按账号也回落共享实例
    expect(listPlatforms()).toEqual(["mock"]);
    expect(listAdapters()).toContain(legacy);
  });

  it("工厂注册的平台出现在 listPlatforms/listAdapters(默认实例)", () => {
    registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId));
    expect(listPlatforms()).toEqual(["mock"]);
    const listed = listAdapters();
    expect(listed.length).toBe(1);
    expect(listed[0]).toBe(getAdapterForAccount("mock"));
  });

  it("重复注册(工厂/直注册互斥)抛 already registered", () => {
    registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId));
    expect(() => registerAdapterFactory("mock", (accountId) => new MockAdapter(accountId))).toThrow("already registered");
    expect(() => registerAdapter(new MockAdapter())).toThrow("already registered");
  });
});

describe("scraper contextKey 按账号", () => {
  it("③ douyin: a1 → 'douyin:a1';无 accountId → 'douyin:default'", () => {
    expect(new DouyinScraper("a1").contextKey).toBe("douyin:a1");
    expect(new DouyinScraper().contextKey).toBe("douyin:default");
    expect(new DouyinScraper(undefined).contextKey).toBe("douyin:default");
  });

  it("③ xiaohongshu: a1 → 'xiaohongshu:a1';无 accountId → 'xiaohongshu:default'", () => {
    expect(new XiaohongshuScraper("a1").contextKey).toBe("xiaohongshu:a1");
    expect(new XiaohongshuScraper().contextKey).toBe("xiaohongshu:default");
  });
});

describe("playwright-helper 画像目录两级", () => {
  it("④ getContext('douyin:a1') 画像目录 = PROFILE_DIR/douyin/a1", () => {
    expect(resolveProfileDir("douyin:a1")).toBe(join(PROFILE_DIR, "douyin", "a1"));
    expect(resolveProfileDir("douyin:default")).toBe(join(PROFILE_DIR, "douyin", "default"));
    expect(resolveProfileDir("xiaohongshu:acc-9")).toBe(join(PROFILE_DIR, "xiaohongshu", "acc-9"));
  });
});

// ── 顺带 deferred minor:惰性 resolve 直接用例(kuaishou/zhihu)+ 缺凭证前置报错 ──

function addAccount(id: string, platform: string) {
  const ts = "2026-01-01";
  getDb().prepare(
    "INSERT INTO accounts (id, name, platform, status, is_default, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)"
  ).run(id, `号-${id}`, platform, ts, ts);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("官方 API adapter 惰性 resolve 按账号(kuaishou/zhihu)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ access_token: "tok", expires_in: 7200 }))
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    closeDb();
  });

  it("kuaishou:实例 accountId 命中该账号凭证,token 请求带账号 app_id/app_secret", async () => {
    addAccount("ks-a1", "kuaishou");
    setAccountCredential("ks-a1", "app_id", "ks-app-id-a1");
    setAccountCredential("ks-a1", "app_secret", "ks-secret-a1");

    const adapter = new KuaishouAdapter("", "", "ks-a1");
    await adapter.collectAccountMetrics();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("open.kuaishou.com");
    const body = JSON.parse(String(init.body));
    expect(body.app_id).toBe("ks-app-id-a1");
    expect(body.app_secret).toBe("ks-secret-a1");
  });

  it("zhihu:实例 accountId 命中该账号凭证,token 请求带账号 client_id/client_secret", async () => {
    addAccount("zh-a1", "zhihu");
    setAccountCredential("zh-a1", "client_id", "zh-client-a1");
    setAccountCredential("zh-a1", "client_secret", "zh-secret-a1");

    const adapter = new ZhihuAdapter("", "", "zh-a1");
    await adapter.collectAccountMetrics();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.zhihu.com");
    const body = JSON.parse(String(init.body));
    expect(body.client_id).toBe("zh-client-a1");
    expect(body.client_secret).toBe("zh-secret-a1");
  });

  it("token 缓存按实例隔离:两个账号实例各自取 token,同实例复用", async () => {
    addAccount("ks-a1", "kuaishou");
    addAccount("ks-a2", "kuaishou");
    setAccountCredential("ks-a1", "app_id", "id-a1");
    setAccountCredential("ks-a1", "app_secret", "sec-a1");
    setAccountCredential("ks-a2", "app_id", "id-a2");
    setAccountCredential("ks-a2", "app_secret", "sec-a2");

    const a1 = new KuaishouAdapter("", "", "ks-a1");
    const a2 = new KuaishouAdapter("", "", "ks-a2");
    await a1.collectAccountMetrics();
    await a1.collectAccountMetrics();
    await a2.collectAccountMetrics();

    const tokenCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("oauth2/access_token")
    );
    expect(tokenCalls.length).toBe(2); // a1 缓存复用,a2 独立取一次
    const bodies = tokenCalls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).app_id);
    expect(bodies).toContain("id-a1");
    expect(bodies).toContain("id-a2");
  });

  it("kuaishou 全无凭证 → 前置报'缺少凭证',不发请求", async () => {
    const adapter = new KuaishouAdapter("", "", "ks-nope");
    await expect(adapter.collectAccountMetrics()).rejects.toThrow("缺少凭证");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("zhihu 全无凭证 → 前置报'缺少凭证',不发请求", async () => {
    const adapter = new ZhihuAdapter("", "");
    await expect(adapter.collectAccountMetrics()).rejects.toThrow("缺少凭证");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
