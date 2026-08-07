import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { DouyinWebPublisher } from "../../src/services/publishers/douyin-web-publisher.js";
import type { Page, Browser, BrowserContext } from "playwright";
import type { PublishInput } from "../../src/services/publishers/types.js";

class MockLocator {
  constructor(private actions: { text?: string; visible?: boolean; waitFails?: boolean } = {}) {}
  // first() must be synchronous — the real Playwright Locator.first() is sync
  first() { return new MockLocator(this.actions); }
  async fill(v: string) { this.actions.text = v; }
  async click() {}
  async setInputFiles(_files?: unknown) {}
  async press() {}
  async waitFor() { if (this.actions.waitFails) throw new Error("locator waitFor timeout"); }
  async isVisible() { return this.actions.visible ?? true; }
}

class MockPage {
  currentUrl = "https://creator.douyin.com/creator-micro/content/upload";
  navigations: string[] = [];
  /** false 时模拟"发布后无任何成功信号"（回归：不得假报成功） */
  confirmSuccess = true;
  async goto(url: string) { this.navigations.push(url); }
  url() { return this.currentUrl; }
  async waitForTimeout() {}
  async waitForSelector() {}
  async waitForURL() {
    if (!this.confirmSuccess) throw new Error("waitForURL timeout");
    this.currentUrl = "https://creator.douyin.com/creator-micro/content/manage";
  }
  async close() {}
  // doUpload 的 evaluate 调用:草稿检测/上传完成文本/自主声明。
  // 返回含"重新上传"的文本使上传完成轮询立即通过;其余返回值不被使用。
  async evaluate() { return "重新上传 更换视频"; }
  locator(selector: string) {
    // 结果校验只针对 text=/…/ 成功/失败提示；上传阶段的 waitFor 不受影响
    const waitFails = !this.confirmSuccess && selector.startsWith("text=");
    return new MockLocator({ waitFails });
  }
}

class TestDouyinWeb extends DouyinWebPublisher {
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

describe("DouyinWebPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("upload navigates to upload page and clicks publish", async () => {
    const pub = new TestDouyinWeb();
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "测试标题" };
    const res = await pub.publish(input);
    expect(res.success).toBe(true);
    expect(pub.getMockPage().navigations).toContain("https://creator.douyin.com/creator-micro/content/upload");
  });

  it("returns error when not logged in", async () => {
    const pub = new TestDouyinWeb();
    pub.loggedIn = false;
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "T" };
    const res = await pub.publish(input);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("发布结果无法确认时按失败处理（不假报成功）", async () => {
    const pub = new TestDouyinWeb();
    pub.getMockPage().confirmSuccess = false;
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "T" };
    const res = await pub.publish(input);
    expect(res.success).toBe(false);
    expect(res.error).toContain("无法确认");
  });
});
