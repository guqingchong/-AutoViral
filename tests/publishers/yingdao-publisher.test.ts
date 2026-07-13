import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { YingdaoRPAPublisher } from "../../src/services/publishers/yingdao-publisher.js";
import type { PublishInput, PublishOutput } from "../../src/services/publishers/types.js";

vi.mock("node:fs", () => ({
  existsSync: (p: string) => p === "C:/yingdao/channels.bot",
}));

class TestYingdao extends YingdaoRPAPublisher {
  readonly platform = "test-yingdao";
  readonly name = "测试影刀";
  readonly botFileName = "test.bot";
  public runCalled: { botPath: string; args: string[] } | null = null;

  protected override buildBotArgs(input: PublishInput): string[] {
    return ["--video", input.videoPath, "--title", input.title];
  }

  protected override runBot(botPath: string, args: string[]): Promise<PublishOutput> {
    this.runCalled = { botPath, args };
    return Promise.resolve({ success: true });
  }
}

describe("YingdaoRPAPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("isConfigured when bot path exists", () => {
    setCredential("test-yingdao", "yingdao_bot_path", "C:/yingdao/channels.bot");
    const pub = new TestYingdao();
    expect(pub.isConfigured()).toBe(true);
  });

  it("returns error when bot path missing", async () => {
    const pub = new TestYingdao();
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("runs bot with args", async () => {
    setCredential("test-yingdao", "yingdao_bot_path", "C:/yingdao/channels.bot");
    const pub = new TestYingdao();
    await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(pub.runCalled).not.toBeNull();
    expect(pub.runCalled?.args).toContain("--video");
  });
});
