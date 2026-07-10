import { describe, it, expect } from "vitest";
import { createMockDriver } from "../../src/services/publish-drivers/mock-driver.js";

describe("mock publish driver", () => {
  it("publishes to a known platform", async () => {
    const driver = createMockDriver("xiaohongshu");
    const result = await driver.publish({
      title: "标题",
      content: "正文",
      mediaPath: "/tmp/video.mp4",
    });
    expect(result.postUrl).toContain("xiaohongshu");
    expect(result.publishedAt).toBeDefined();
  });

  it("throws for unknown platform", () => {
    expect(() => createMockDriver("unknown")).toThrow();
  });
});
