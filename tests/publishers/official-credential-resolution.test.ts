import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { setAccountCredential } from "../../src/db/account-credentials-repo.js";
import { BilibiliOfficialPublisher } from "../../src/services/publishers/bilibili-official-publisher.js";
import { ZhihuOfficialPublisher } from "../../src/services/publishers/zhihu-official-publisher.js";
import { WechatAdapter } from "../../src/services/platform-adapters/wechat-api.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-video-data")),
}));

function seedAccount(id: string, platform: string) {
  createAccount({
    id,
    name: id,
    platform,
    tone_profile: {},
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface FetchCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: unknown };
}

/** bilibili 发布全流程 mock:preupload → init → PUT chunk → complete → add/v3 */
function mockBilibiliFlow(calls: FetchCall[]) {
  global.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const u = String(url);
    calls.push({ url: u, init: init as FetchCall["init"] });
    if (u.includes("/preupload")) {
      return jsonResponse({
        OK: 1,
        auth: "upos-auth",
        biz_id: 42,
        chunk_size: 10 * 1024 * 1024,
        endpoint: "//upos-cdn.example.com",
        upos_uri: "upos://i/v.mp4",
      });
    }
    if (u.includes("uploads&output=json")) return jsonResponse({ upload_id: "u1" });
    if (u.includes("partNumber=")) return jsonResponse({}, true);
    if (u.includes("output=json&name=")) return jsonResponse({ OK: 1 });
    if (u.includes("/x/vu/web/add/v3")) return jsonResponse({ code: 0, data: { bvid: "BV1xx" } });
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("官方发布器凭证走账号维度(resolveAccountCredential)", () => {
  let origFetch: typeof global.fetch;
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.clearAllMocks();
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
    closeDb();
  });

  it("① bilibili 发布用指定账号的 access_token/csrf(旧表有不同值也不抢)", async () => {
    seedAccount("acc-b1", "bilibili");
    setAccountCredential("acc-b1", "access_token", "SESS_ACC");
    setAccountCredential("acc-b1", "csrf", "csrf_acc");
    // 旧表放不同值:若仍读旧表,断言会抓到 SESS_OLD
    setCredential("bilibili", "access_token", "SESS_OLD");
    setCredential("bilibili", "csrf", "csrf_old");

    const calls: FetchCall[] = [];
    mockBilibiliFlow(calls);

    const pub = new BilibiliOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
      accountId: "acc-b1",
    });
    expect(res.success).toBe(true);

    const preupload = calls.find((c) => c.url.includes("/preupload"));
    expect(preupload?.init?.headers?.Cookie).toContain("SESSDATA=SESS_ACC");
    expect(preupload?.init?.headers?.Cookie).toContain("bili_jct=csrf_acc");
    const add = calls.find((c) => c.url.includes("/x/vu/web/add/v3"));
    expect(add?.url).toContain("csrf=csrf_acc");
  });

  it("② 账号无凭证但旧表有 → deprecated 兜底仍可用", async () => {
    seedAccount("acc-b2", "bilibili"); // 无任何账号凭证
    setCredential("bilibili", "access_token", "SESS_OLD");
    setCredential("bilibili", "csrf", "csrf_old");

    const calls: FetchCall[] = [];
    mockBilibiliFlow(calls);

    const pub = new BilibiliOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
      accountId: "acc-b2",
    });
    expect(res.success).toBe(true);
    const preupload = calls.find((c) => c.url.includes("/preupload"));
    expect(preupload?.init?.headers?.Cookie).toContain("SESSDATA=SESS_OLD");
  });

  it("③ 全无凭证 → 发布失败报缺少凭证而非静默", async () => {
    const pub = new BilibiliOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
      accountId: "acc-nonexistent",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("缺少");
  });

  it("① zhihu 发布用指定账号的 access_token(Bearer)", async () => {
    seedAccount("acc-z1", "zhihu");
    setAccountCredential("acc-z1", "access_token", "zh_acc_token");
    setCredential("zhihu", "access_token", "zh_old_token");

    global.fetch = vi.fn(async () =>
      jsonResponse({ id: "123", url: "https://zhuanlan.zhihu.com/p/123" })
    ) as unknown as typeof fetch;

    const pub = new ZhihuOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
      accountId: "acc-z1",
    });
    expect(res.success).toBe(true);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer zh_acc_token");
  });

  it("③ zhihu 全无凭证 → 报缺少凭证", async () => {
    const pub = new ZhihuOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("缺少");
  });

  it("④ 官方 API adapter(wechat)采集时惰性 resolve 账号维度凭证,不靠构造参数", async () => {
    seedAccount("acc-w1", "wechat");
    setAccountCredential("acc-w1", "app_id", "wx_acc_appid");
    setAccountCredential("acc-w1", "app_secret", "wx_acc_secret");
    // 默认账号,adapter 无 accountId 入参 → 走平台默认账号链
    const { getDb } = await import("../../src/db/connection.js");
    getDb().prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run("acc-w1");

    const calls: FetchCall[] = [];
    global.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      calls.push({ url: u, init: init as FetchCall["init"] });
      if (u.includes("/cgi-bin/token")) {
        return jsonResponse({ access_token: "wx_tok", expires_in: 7200 });
      }
      return jsonResponse({ total: 7 });
    }) as unknown as typeof fetch;

    // 构造时不给任何凭证(且环境变量为空)——凭证必须在使用点惰性 resolve
    const adapter = new WechatAdapter("", "");
    const metrics = await adapter.collectAccountMetrics();
    expect(metrics.followers).toBe(7);
    const tokenCall = calls.find((c) => c.url.includes("/cgi-bin/token"));
    expect(tokenCall?.url).toContain("appid=wx_acc_appid");
    expect(tokenCall?.url).toContain("secret=wx_acc_secret");
  });
});
