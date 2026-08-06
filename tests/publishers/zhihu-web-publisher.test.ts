import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { ZhihuWebPublisher } from "../../src/services/publishers/zhihu-web-publisher.js";
import type { Browser, BrowserContext, Page } from "playwright";

class MockLocator {
  clicks = 0;
  fills: string[] = [];
  uploads: string[] = [];
  constructor(private countValue: number) {}
  first(): MockLocator {
    return this;
  }
  async click(): Promise<void> {
    this.clicks++;
  }
  async fill(v: string): Promise<void> {
    this.fills.push(v);
  }
  async count(): Promise<number> {
    return this.countValue;
  }
  async isVisible(): Promise<boolean> {
    return false; // 浮层关闭按钮默认不可见,dismissOverlays 应静默跳过
  }
  async setInputFiles(p: string): Promise<void> {
    this.uploads.push(p);
  }
}

class MockPage {
  fileLocator = new MockLocator(1);
  genericLocator = new MockLocator(1);
  typed: string[] = [];
  enterPresses = 0;
  closed = false;

  constructor(fileInputCount = 1) {
    this.fileLocator = new MockLocator(fileInputCount);
  }

  async goto(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  async waitForURL(): Promise<void> {}
  url(): string {
    return "https://zhuanlan.zhihu.com/p/12345";
  }
  locator(selector: string): MockLocator {
    if (selector.includes('input[type="file"]')) return this.fileLocator;
    // 风控页检测选择器默认无匹配(页面正常)
    if (selector.includes("请求存在异常")) return new MockLocator(0);
    return this.genericLocator;
  }
  keyboard = {
    type: async (t: string) => {
      this.typed.push(t);
    },
    press: async (key: string) => {
      if (key === "Enter") this.enterPresses++;
    },
  };
  async close(): Promise<void> {
    this.closed = true;
  }
}

class TestZhihuPublisher extends ZhihuWebPublisher {
  constructor(private mockPage: MockPage) {
    super({ headless: true });
  }
  protected override async ensureBrowser(): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }> {
    return {
      browser: { close: async () => {} } as unknown as Browser,
      context: {
        cookies: async () => [],
        close: async () => {},
      } as unknown as BrowserContext,
      page: this.mockPage as unknown as Page,
    };
  }
  protected override async checkLoggedIn(): Promise<boolean> {
    return true;
  }
}

describe("ZhihuWebPublisher 正文配图", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    setCredential(
      "zhihu",
      "session_cookie",
      JSON.stringify([{ name: "s", value: "1", domain: ".zhihu.com", path: "/" }])
    );
  });
  afterEach(() => closeDb());

  const sixLines = ["第一段", "第二段", "第三段", "第四段", "第五段", "第六段"].join("\n");

  it("有 contentImages 时在段落间通过 setInputFiles 上传插图", async () => {
    const page = new MockPage(1);
    const pub = new TestZhihuPublisher(page);
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "标题",
      options: {
        content: sixLines,
        contentImages: ["/tmp/a.png", "/tmp/b.png"],
      },
    });

    expect(res.success).toBe(true);
    expect(page.fileLocator.uploads).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    // 正文六行全部输入
    expect(page.typed).toEqual(["第一段", "第二段", "第三段", "第四段", "第五段", "第六段"]);
  });

  it("无 contentImages 时不上传图片，行为与纯文本一致", async () => {
    const page = new MockPage(1);
    const pub = new TestZhihuPublisher(page);
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "标题",
      options: { content: sixLines },
    });

    expect(res.success).toBe(true);
    expect(page.fileLocator.uploads).toEqual([]);
    expect(page.typed).toEqual(["第一段", "第二段", "第三段", "第四段", "第五段", "第六段"]);
    // 6 行 5 次换行
    expect(page.enterPresses).toBe(5);
  });

  it("定位不到上传入口时降级纯文本，不中断发布", async () => {
    const page = new MockPage(0); // input[type=file] 不存在
    const pub = new TestZhihuPublisher(page);
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      title: "标题",
      options: { content: sixLines, contentImages: ["/tmp/a.png", "/tmp/b.png"] },
    });

    expect(res.success).toBe(true);
    expect(page.fileLocator.uploads).toEqual([]);
    expect(page.typed.length).toBe(6);
  });
});
