import { describe, it, expect } from "vitest";
import { getDriver } from "../../src/services/publish-factory.js";

describe("publish-factory", () => {
  it("returns mock driver for known platforms", () => {
    const driver = getDriver("xiaohongshu");
    expect(driver.platform).toBe("xiaohongshu");
  });

  it("throws for unregistered platforms", () => {
    expect(() => getDriver("unknown")).toThrow("Unsupported platform");
  });
});
