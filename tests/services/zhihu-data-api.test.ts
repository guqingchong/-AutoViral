import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("zhihu-data-api", () => {
  let svc: typeof import("../../src/services/zhihu-data-api.js");
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function mockConfig(secret?: string) {
    return { zhihuData: secret ? { accessSecret: secret } : undefined } as any;
  }

  beforeEach(async () => {
    vi.resetModules();
    const configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(mockConfig("test-secret"));
    fetchSpy = vi.spyOn(globalThis, "fetch");
    svc = await import("../../src/services/zhihu-data-api.js");
  });
  afterEach(() => vi.restoreAllMocks());

  function mockResponse(body: unknown, ok = true, status = 200) {
    fetchSpy.mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }

  it("未配置 Secret 时热榜返回空数组且不发起请求", async () => {
    const configModule = await import("../../src/config.js");
    (configModule.loadConfig as any).mockResolvedValue(mockConfig(undefined));
    const items = await svc.fetchZhihuHotList();
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("热榜请求带 Bearer 鉴权与秒级时间戳", async () => {
    mockResponse({ data: [] });
    await svc.fetchZhihuHotList(10);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/content/hot_list");
    expect(url).toContain("Limit=10");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-secret");
    expect(Number(headers["X-Request-Timestamp"])).toBeGreaterThan(1_700_000_000);
    expect(headers["X-Request-Timestamp"].length).toBe(10); // 秒级
  });

  it("热榜解析嵌套 data 列表并过滤空标题", async () => {
    mockResponse({ data: [{ title: "如何看待AI", heat: "500万", url: "u1" }, { title: "" }] });
    const items = await svc.fetchZhihuHotList();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "如何看待AI", heat: "500万" });
  });

  it("知乎搜索传 Query/Count 并截断摘要", async () => {
    const longText = "x".repeat(500);
    mockResponse({ data: [{ title: "t", excerpt: longText, url: "u", author_name: "张三", voteup_count: 42 }] });
    const items = await svc.zhihuSearch("芯片", 5);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/content/zhihu_search");
    expect(url).toContain("Query=%E8%8A%AF%E7%89%87");
    expect(items[0].excerpt).toHaveLength(300);
    expect(items[0]).toMatchObject({ author: "张三", voteupCount: 42 });
  });

  it("全网搜索走 global_search 且 SearchDB=all", async () => {
    mockResponse({ items: [{ title: "t", content: "c" }] });
    const items = await svc.globalSearch("新能源", 3);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/content/global_search");
    expect(url).toContain("SearchDB=all");
    expect(items).toHaveLength(1);
  });

  it("HTTP 错误抛出带状态码的异常", async () => {
    mockResponse({}, false, 401);
    await expect(svc.fetchZhihuHotList()).rejects.toThrow("401");
  });
});
