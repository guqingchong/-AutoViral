import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { ChannelsPublisher } from "../../src/services/publishers/channels-publisher.js";

vi.mock("node:fs", () => ({
  existsSync: (p: string) => p === "C:/yingdao/channels_publish.bot",
}));

describe("ChannelsPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("isConfigured when yingdao bot path exists", async () => {
    setCredential("channels", "yingdao_bot_path", "C:/yingdao/channels_publish.bot");
    const pub = new ChannelsPublisher();
    await expect(pub.isConfigured()).resolves.toBe(true);
  });

  it("isConfigured when session_cookie JSON array exists", async () => {
    setCredential("channels", "session_cookie", JSON.stringify([{ name: "a", value: "b" }]));
    const pub = new ChannelsPublisher();
    await expect(pub.isConfigured()).resolves.toBe(true);
  });

  it("not configured when neither bot path nor valid cookie", async () => {
    const pub = new ChannelsPublisher();
    await expect(pub.isConfigured()).resolves.toBe(false);
    // 非 JSON 的 cookie 字符串也不算就绪
    setCredential("channels", "session_cookie", "pac_uid=0_xxx; omgid=0_xxx");
    const pub2 = new ChannelsPublisher();
    await expect(pub2.isConfigured()).resolves.toBe(false);
  });
});
