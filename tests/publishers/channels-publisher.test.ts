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

  it("isConfigured when bot path exists", () => {
    setCredential("channels", "yingdao_bot_path", "C:/yingdao/channels_publish.bot");
    const pub = new ChannelsPublisher();
    expect(pub.isConfigured()).toBe(true);
  });
});
