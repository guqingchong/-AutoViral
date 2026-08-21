/**
 * verifyChannels 按账号画像目录(2026-08-21 视频号"需重新登录"根因):
 * Task 5 把登录/发布迁到 browser-profiles/<platform>/<accountId>,
 * 但 verifyChannels 仍检测旧单级目录 browser-profiles/channels ——
 * 扫码登录明明成功(会话在账号画像里),健康检查却测旧画像报失效。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { setAccountCredential, getAccountCredential } from "../../src/db/account-credentials-repo.js";

const launchCalls: string[] = [];

// 已登录态的假页面:URL 不含 login,无登录墙,有"发表动态"信号
function makeSignedInContext() {
  const page = {
    goto: async () => {},
    url: () => "https://channels.weixin.qq.com/platform/post/create",
    locator: (sel: string) => ({
      count: async () => (/登录视频号助手|扫码登录|微信扫码/.test(sel) ? 0 : 1),
    }),
    waitForTimeout: async () => {},
  };
  return {
    newPage: async () => page,
    cookies: async () => [{ name: "s", value: "fresh", domain: ".weixin.qq.com", path: "/" }],
    close: async () => {},
  };
}

vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: vi.fn(async (profileDir: string) => {
      launchCalls.push(profileDir);
      return makeSignedInContext();
    }),
    launch: vi.fn(async () => ({ close: async () => {} })),
  },
}));

import { verifyAllAccounts } from "../../src/services/login-health.js";
import { resolveProfileDir } from "../../src/services/publishers/playwright-publisher.js";

const ACC = "acc-ch-1";
const COOKIE = JSON.stringify([{ name: "s", value: "1", domain: ".weixin.qq.com", path: "/" }]);

describe("verifyChannels 按账号画像", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    launchCalls.length = 0;
    createAccount({
      id: ACC, name: "视频号A", platform: "channels", tone_profile: {}, status: "active",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    setAccountCredential(ACC, "session_cookie", COOKIE);
  });
  afterEach(() => closeDb());

  it("健康检查使用 per-account 画像目录(与登录/发布同一目录)", async () => {
    const results = await verifyAllAccounts(true);
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]).toBe(resolveProfileDir("channels", ACC));
    expect(results[0].valid).toBe(true);
  });

  it("检测有效时画像内新 cookie 同步回 account_credentials(不只写旧表)", async () => {
    await verifyAllAccounts(true);
    const synced = getAccountCredential(ACC, "session_cookie");
    expect(synced).toContain("fresh");
  });
});
