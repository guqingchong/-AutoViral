import { describe, it, expect } from "vitest";
import { createMockDriver } from "../../src/services/publish-drivers/mock-driver.js";

describe("mock publish driver", () => {
  it("publishes to a known platform with default options (no delay, no failure)", async () => {
    const driver = createMockDriver("xiaohongshu");
    const result = await driver.publish({
      title: "标题",
      content: "正文",
      mediaPath: "/tmp/video.mp4",
    });
    expect(result.postUrl).toContain("xiaohongshu");
    expect(result.publishedAt).toBeDefined();
  });

  it("publishes successfully even with delay", async () => {
    const driver = createMockDriver("xiaohongshu", { delayMs: 10 });
    const result = await driver.publish({ title: "标题", content: "正文" });
    expect(result.postUrl).toContain("xiaohongshu");
  });

  it("throws when simulateFailure is true", async () => {
    const driver = createMockDriver("xiaohongshu", { simulateFailure: true });
    await expect(driver.publish({ title: "标题", content: "正文" })).rejects.toThrow(
      "Mock xiaohongshu publish failed: simulated failure"
    );
  });

  it("throws for unknown platform", () => {
    expect(() => createMockDriver("unknown")).toThrow();
  });
});
