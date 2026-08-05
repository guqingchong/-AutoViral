import { describe, it, expect, beforeEach } from "vitest";
import { getDriver } from "../../src/services/publish-factory.js";
import { getPublisher, registerAllPublishers, listPublishers } from "../../src/services/publishers/factory.js";

describe("publish-factory (legacy mock driver)", () => {
  it("returns mock driver for known platforms", () => {
    const driver = getDriver("xiaohongshu");
    expect(driver.platform).toBe("xiaohongshu");
  });

  it("throws for unregistered platforms", () => {
    expect(() => getDriver("unknown")).toThrow("Unsupported platform");
  });
});

describe("publishers factory (real publishers)", () => {
  beforeEach(() => {
    registerAllPublishers();
  });

  it("registers all PRD platforms", () => {
    const platforms = listPublishers();
    expect(platforms).toEqual(
      expect.arrayContaining([
        "kuaishou",
        "bilibili",
        "zhihu",
        "wechat",
        "douyin",
        "xiaohongshu",
        "channels",
      ])
    );
  });

  it("resolves the 3 official-API publishers (GAP-1)", () => {
    for (const plat of ["kuaishou", "bilibili", "wechat"]) {
      const p = getPublisher(plat);
      expect(p.platform).toBe(plat);
      expect(typeof p.publish).toBe("function");
      expect(typeof p.isConfigured).toBe("function");
    }
  });

  it("resolves Playwright / RPA publishers", () => {
    for (const plat of ["douyin", "xiaohongshu", "channels", "zhihu"]) {
      const p = getPublisher(plat);
      expect(p.platform).toBe(plat);
    }
  });

  it("throws for unknown platform", () => {
    expect(() => getPublisher("unknown")).toThrow("No publisher registered");
  });
});