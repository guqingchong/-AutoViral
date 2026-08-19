import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { ChannelsPublisher } from "../../src/services/publishers/channels-publisher.js";

// 2026-08-19:影刀 RPA 兜底已删除(从未跑通、无人配置),视频号 = 纯 Playwright 网页自动化
describe("ChannelsPublisher(纯 Playwright)", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("isConfigured when session_cookie JSON array exists", async () => {
    setCredential("channels", "session_cookie", JSON.stringify([{ name: "a", value: "b" }]));
    const pub = new ChannelsPublisher();
    await expect(pub.isConfigured()).resolves.toBe(true);
  });

  it("not configured when missing or invalid cookie", async () => {
    const pub = new ChannelsPublisher();
    await expect(pub.isConfigured()).resolves.toBe(false);
    // 非 JSON 的 cookie 字符串也不算就绪
    setCredential("channels", "session_cookie", "pac_uid=0_xxx; omgid=0_xxx");
    const pub2 = new ChannelsPublisher();
    await expect(pub2.isConfigured()).resolves.toBe(false);
  });
});
