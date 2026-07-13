import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { DouyinOfficialPublisher } from "../../src/services/publishers/douyin-official-publisher.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-video-data")),
}));

describe("DouyinOfficialPublisher", () => {
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

  it("isConfigured requires access_token and open_id", () => {
    setCredential("douyin", "app_key", "ak");
    const pub = new DouyinOfficialPublisher();
    expect(pub.isConfigured()).toBe(false);
    setCredential("douyin", "access_token", "tk");
    setCredential("douyin", "open_id", "oid");
    expect(pub.isConfigured()).toBe(true);
  });

  it("returns error when credentials missing", async () => {
    const pub = new DouyinOfficialPublisher();
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("access_token");
  });

  it("publishes via API when response ok", async () => {
    setCredential("douyin", "app_key", "ak");
    setCredential("douyin", "access_token", "tk");
    setCredential("douyin", "open_id", "oid");

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({ data: { error_code: 0, video: { video_id: "v123" } } }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ data: { error_code: 0, item_id: "i456" } }),
      }) as unknown as typeof fetch;

    const pub = new DouyinOfficialPublisher();
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(res.success).toBe(true);
    expect(res.postUrl).toContain("i456");
  });
});
