import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { XiaohongshuPublisher } from "../../src/services/publishers/xiaohongshu-publisher.js";
import type { Page, Browser, BrowserContext } from "playwright";
import type { PublishInput } from "../../src/services/publishers/types.js";

class MockLocator {
  first() { return this; }
  async fill() {}
  async click() {}
  async setInputFiles() {}
  async press() {}
}

class MockPage {
  currentUrl = "https://creator.xiaohongshu.com/publish/publish";
  navigations: string[] = [];
  async goto(url: string) { this.navigations.push(url); }
  url() { return this.currentUrl; }
  async waitForTimeout() {}
  async close() {}
  locator() { return new MockLocator(); }
}

class TestXHS extends XiaohongshuPublisher {
  private mockPage = new MockPage();
  loggedIn = true;

  protected override async ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    return {
      browser: { close: async () => {} } as unknown as Browser,
      context: { cookies: async () => [], close: async () => {} } as unknown as BrowserContext,
      page: this.mockPage as unknown as Page,
    };
  }

  protected override async checkLoggedIn(_page: Page): Promise<boolean> {
    return this.loggedIn;
  }

  getMockPage() { return this.mockPage; }
}

describe("XiaohongshuPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("publishes when logged in", async () => {
    const pub = new TestXHS();
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "T", options: { description: "D", tags: ["a"] } };
    const res = await pub.publish(input);
    expect(res.success).toBe(true);
    expect(pub.getMockPage().navigations).toContain("https://creator.xiaohongshu.com/publish/publish");
  });

  it("returns error when not logged in", async () => {
    const pub = new TestXHS();
    pub.loggedIn = false;
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
