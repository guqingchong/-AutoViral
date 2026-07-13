import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { DouyinPublisher } from "../../src/services/publishers/douyin-publisher.js";
import type { Publisher } from "../../src/services/publishers/types.js";

describe("DouyinPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("uses web publisher when official not configured", async () => {
    const web = {
      publish: vi.fn().mockResolvedValue({ success: true, postUrl: "https://web" }),
      isConfigured: vi.fn().mockResolvedValue(false),
    } as unknown as Publisher;
    const official = { isConfigured: vi.fn().mockReturnValue(false) } as unknown as Publisher;
    const pub = new DouyinPublisher(official, web);
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(web.publish).toHaveBeenCalled();
    expect(res.postUrl).toBe("https://web");
  });

  it("tries official first and falls back to web", async () => {
    setCredential("douyin", "app_key", "ak");
    setCredential("douyin", "access_token", "tk");
    setCredential("douyin", "open_id", "oid");

    const official = {
      isConfigured: vi.fn().mockReturnValue(true),
      publish: vi.fn().mockResolvedValue({ success: false, error: "api limit" }),
    } as unknown as Publisher;
    const web = {
      publish: vi.fn().mockResolvedValue({ success: true, postUrl: "https://web" }),
    } as unknown as Publisher;
    const pub = new DouyinPublisher(official, web);
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(official.publish).toHaveBeenCalled();
    expect(web.publish).toHaveBeenCalled();
    expect(res.success).toBe(true);
  });
});
