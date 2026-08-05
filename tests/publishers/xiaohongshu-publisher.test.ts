import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { XiaohongshuPublisher } from "../../src/services/publishers/xiaohongshu-publisher.js";
import type { Page, Browser, BrowserContext } from "playwright";
import type { PublishInput } from "../../src/services/publishers/types.js";

class MockLocator {
  clicks: string[] = [];
  uploads: Array<string | string[]> = [];
  fills: string[] = [];
  constructor(private label = "") {}
  first() { return this; }
  async fill(v: string) { this.fills.push(v); }
  async click() { this.clicks.push(this.label); }
  async setInputFiles(p: string | string[]) { this.uploads.push(p); }
  async press() {}
}

class MockPage {
  currentUrl = "https://creator.xiaohongshu.com/publish/publish";
  navigations: string[] = [];
  locators: MockLocator[] = [];
  async goto(url: string) { this.navigations.push(url); }
  url() { return this.currentUrl; }
  async waitForTimeout() {}
  async close() {}
  locator(selector: string) {
    const l = new MockLocator(selector);
    this.locators.push(l);
    return l;
  }
  /** 所有 locator 的点击标签（即 selector 文本） */
  clickLog(): string[] { return this.locators.flatMap((l) => l.clicks); }
  uploadLog(): Array<string | string[]> { return this.locators.flatMap((l) => l.uploads); }
  fillLog(): string[] { return this.locators.flatMap((l) => l.fills); }
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

  it("无 imagePaths 时走「发布视频」链路上传视频", async () => {
    const pub = new TestXHS();
    const res = await pub.publish({ workId: "w1", videoPath: "/tmp/v.mp4", title: "T" });
    expect(res.success).toBe(true);
    const page = pub.getMockPage();
    expect(page.clickLog().some((s) => s.includes("发布视频"))).toBe(true);
    expect(page.clickLog().some((s) => s.includes("上传图文"))).toBe(false);
    expect(page.uploadLog()).toContain("/tmp/v.mp4");
  });

  it("options.imagePaths 非空时走「上传图文」链路，多图一次上传", async () => {
    const pub = new TestXHS();
    const cards = ["/cards/01-cover.png", "/cards/02-card.png"];
    const res = await pub.publish({
      workId: "w1",
      videoPath: "",
      title: "这是一个超过二十个字的小红书图文笔记标题需要被截断",
      options: { imagePaths: cards, description: "配文" },
    });
    expect(res.success).toBe(true);
    const page = pub.getMockPage();
    expect(page.clickLog().some((s) => s.includes("上传图文"))).toBe(true);
    expect(page.clickLog().some((s) => s.includes("发布视频"))).toBe(false);
    expect(page.uploadLog()).toContainEqual(cards);
    // 图文标题截断到 20 字
    expect(page.fillLog().some((v) => v.length <= 20 && v.startsWith("这是一个"))).toBe(true);
    expect(page.fillLog()).toContain("配文");
  });

  it("imagePaths 中的空串被过滤，全空时回退视频链路", async () => {
    const pub = new TestXHS();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "T",
      options: { imagePaths: ["", ""] },
    });
    expect(res.success).toBe(true);
    expect(pub.getMockPage().clickLog().some((s) => s.includes("发布视频"))).toBe(true);
  });
});
