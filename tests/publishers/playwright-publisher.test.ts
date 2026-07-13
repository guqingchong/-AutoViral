import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { PlaywrightPublisher, type PlaywrightOptions } from "../../src/services/publishers/playwright-publisher.js";
import type { PublishInput, PublishOutput } from "../../src/services/publishers/types.js";
import type { Page, Browser, BrowserContext } from "playwright";

class TestPublisher extends PlaywrightPublisher {
  readonly platform = "test-platform";
  readonly name = "测试平台";
  readonly loginUrl = "https://test.example/login";
  readonly uploadUrl = "https://test.example/upload";
  loggedIn = false;
  uploaded = false;

  constructor(opts: PlaywrightOptions = {}, private mockPage: MockPage) {
    super(opts);
  }

  protected override async ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    return {
      browser: {} as Browser,
      context: { cookies: async () => [{ name: "s", value: "1", domain: ".example.com", path: "/" }] } as unknown as BrowserContext,
      page: this.mockPage as unknown as Page,
    };
  }

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    return this.loggedIn;
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    this.uploaded = true;
    return { success: true, postUrl: "https://test.example/post/1" };
  }
}

class MockPage {
  urlValue = "https://test.example/upload";
  closed = false;
  navigations: string[] = [];
  async goto(url: string) { this.navigations.push(url); }
  async close() { this.closed = true; }
  url() { return this.urlValue; }
  async waitForTimeout() {}
}

describe("PlaywrightPublisher", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("isConfigured returns false when no cookie", async () => {
    const pub = new TestPublisher({}, new MockPage());
    expect(await pub.isConfigured()).toBe(false);
  });

  it("isConfigured returns true with valid cookie", async () => {
    setCredential("test-platform", "session_cookie", JSON.stringify([{ name: "s", value: "1", domain: ".example.com", path: "/" }]));
    const pub = new TestPublisher({}, new MockPage());
    expect(await pub.isConfigured()).toBe(true);
  });

  it("publish succeeds when logged in", async () => {
    const mock = new MockPage();
    const pub = new TestPublisher({}, mock);
    pub.loggedIn = true;
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "T" };
    const res = await pub.publish(input);
    expect(res.success).toBe(true);
    expect(pub.uploaded).toBe(true);
    expect(mock.closed).toBe(true);
  });

  it("publish returns error when not logged in", async () => {
    const mock = new MockPage();
    const pub = new TestPublisher({}, mock);
    pub.loggedIn = false;
    const input: PublishInput = { workId: "w1", videoPath: "/tmp/v.mp4", title: "T" };
    const res = await pub.publish(input);
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(pub.uploaded).toBe(false);
  });
});
