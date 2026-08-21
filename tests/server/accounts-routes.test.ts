import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { getAccountCredential } from "../../src/db/account-credentials-repo.js";
import { getCredential } from "../../src/db/platform-credentials-repo.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

async function createAccount(app: Hono, body: Record<string, unknown>) {
  const res = await app.request("/api/accounts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; platform: string }>;
}

describe("accounts routes — 账号维度凭证(去桥接)", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-accounts-routes-"));
    process.env.AUTOVIRAL_DATA_DIR = testDir;
    resetInMemoryDb();
    migrate();
    app = makeApp();
  });

  afterEach(async () => {
    closeDb();
    process.env.AUTOVIRAL_DATA_DIR = ORIGINAL_ENV;
    await rm(testDir, { recursive: true, force: true });
  });

  it("① POST 创建账号(cookie) → account_credentials 有 session_cookie,旧表 platform_credentials 不再被写入", async () => {
    const account = await createAccount(app, {
      name: "抖音主号", platform: "douyin", cookie: '[{"name":"a","value":"b"}]',
    });
    expect(getAccountCredential(account.id, "session_cookie")).toBe('[{"name":"a","value":"b"}]');
    // 去桥接断言:旧表不再被 accounts 路由写入
    expect(getCredential("douyin", "session_cookie")).toBeUndefined();
  });

  it("② 同平台建第二个账号 → 第一个账号的 account_credentials 不受影响", async () => {
    const a1 = await createAccount(app, { name: "号1", platform: "douyin", cookie: "cookie-1" });
    const a2 = await createAccount(app, { name: "号2", platform: "douyin", cookie: "cookie-2" });
    expect(getAccountCredential(a1.id, "session_cookie")).toBe("cookie-1");
    expect(getAccountCredential(a2.id, "session_cookie")).toBe("cookie-2");
    // 旧表同样不得被写(原 bug:互相顶掉)
    expect(getCredential("douyin", "session_cookie")).toBeUndefined();
  });

  it("PUT /:id 更新 cookie → 落 account_credentials,不写旧表", async () => {
    const a1 = await createAccount(app, { name: "号1", platform: "douyin", cookie: "cookie-1" });
    const res = await app.request(`/api/accounts/${a1.id}`, {
      method: "PUT",
      body: JSON.stringify({ cookie: "cookie-1b" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(getAccountCredential(a1.id, "session_cookie")).toBe("cookie-1b");
    expect(getCredential("douyin", "session_cookie")).toBeUndefined();
  });

  it("wechat_mp 字段映射保留:username→app_id,cookie→app_secret,落 account_credentials", async () => {
    const account = await createAccount(app, {
      name: "公众号", platform: "wechat_mp", username: "wx-appid", cookie: "wx-secret",
    });
    expect(getAccountCredential(account.id, "app_id")).toBe("wx-appid");
    expect(getAccountCredential(account.id, "app_secret")).toBe("wx-secret");
    expect(getCredential("wechat", "app_id")).toBeUndefined();
    expect(getCredential("wechat", "app_secret")).toBeUndefined();
  });

  it("bilibili SESSDATA 解析保留:完整 cookie 拆 access_token/csrf", async () => {
    const account = await createAccount(app, {
      name: "B站号", platform: "bilibili", cookie: "SESSDATA=sess-abc; bili_jct=csrf-xyz; other=1",
    });
    expect(getAccountCredential(account.id, "access_token")).toBe("sess-abc");
    expect(getAccountCredential(account.id, "csrf")).toBe("csrf-xyz");
    expect(getCredential("bilibili", "access_token")).toBeUndefined();
  });

  it("③ POST /:id/default → accounts 表该平台仅该行 is_default=1", async () => {
    const a1 = await createAccount(app, { name: "号1", platform: "douyin" });
    const a2 = await createAccount(app, { name: "号2", platform: "douyin" });
    const a3 = await createAccount(app, { name: "小红书号", platform: "xiaohongshu" });

    // 先把 a1 设为默认,再切到 a2:该平台始终只有一行 is_default=1
    let res = await app.request(`/api/accounts/${a1.id}/default`, { method: "POST" });
    expect(res.status).toBe(200);
    res = await app.request(`/api/accounts/${a2.id}/default`, { method: "POST" });
    expect(res.status).toBe(200);

    const rows = getDb().prepare(
      "SELECT id, is_default FROM accounts WHERE platform = 'douyin'"
    ).all() as { id: string; is_default: number }[];
    const defaults = rows.filter((r) => r.is_default === 1);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(a2.id);
    // 其他平台不受影响
    const xhs = getDb().prepare(
      "SELECT is_default FROM accounts WHERE id = ?"
    ).pluck().get(a3.id);
    expect(xhs).toBe(0);
  });

  it("POST /:id/default 对不存在账号返回 404", async () => {
    const res = await app.request("/api/accounts/nonexistent/default", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("④ DELETE 账号 → 其 account_credentials 级联删除", async () => {
    const a1 = await createAccount(app, { name: "号1", platform: "douyin", cookie: "cookie-1" });
    expect(getAccountCredential(a1.id, "session_cookie")).toBe("cookie-1");
    const res = await app.request(`/api/accounts/${a1.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(getAccountCredential(a1.id, "session_cookie")).toBeUndefined();
    const count = getDb().prepare(
      "SELECT COUNT(*) FROM account_credentials WHERE account_id = ?"
    ).pluck().get(a1.id);
    expect(count).toBe(0);
  });
});
