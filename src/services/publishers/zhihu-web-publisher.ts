import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page } from "playwright";

/**
 * 知乎网页发布器（Playwright 浏览器自动化）。
 *
 * 知乎官方开放平台已不对个人开发者开放 OAuth 申请，官方 API 通道不可用，
 * 因此与抖音/小红书一致，走「浏览器登录 → Cookie 入库 → 自动写文章发布」。
 *
 * 凭证：session_cookie（知乎登录 Cookie JSON 数组）。
 * 发布产物：知乎专栏文章（zhuanlan），正文取自 input.options.content。
 */
export class ZhihuWebPublisher extends PlaywrightPublisher {
  readonly platform = "zhihu";
  readonly name = "知乎网页发布";
  readonly loginUrl = "https://www.zhihu.com/signin";
  readonly uploadUrl = "https://zhuanlan.zhihu.com/write";

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    // 未登录会被重定向到登录页，或页面出现登录框
    if (page.url().includes("signin") || page.url().includes("login")) return false;
    const loginModal = await page.locator('.Modal-wrapper:has-text("登录"), .SignFlowHomepage').count();
    return loginModal === 0;
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const content =
      (input.options?.content as string) ??
      (input.options?.description as string) ??
      "";
    const title = (input.options?.articleTitle as string) ?? input.title;

    // 填写标题（知乎编辑器标题是 textarea）
    const titleBox = page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]').first();
    await titleBox.click();
    await titleBox.fill(title);

    // 填写正文（知乎编辑器正文是 contenteditable 区域）
    const contentBox = page.locator('.public-DraftEditor-content, div[contenteditable="true"]').first();
    await contentBox.click();
    // 逐行输入，换行转成编辑器内段落
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 5 });
      if (i < lines.length - 1) await page.keyboard.press("Enter");
    }

    // 点击「发布」弹出确认面板
    await page.locator('button:has-text("发布")').first().click();
    await page.waitForTimeout(2000);

    // 确认面板中再次点击「确认并发布」/「发布」
    const confirmBtn = page.locator('button:has-text("确认并发布"), button:has-text("确认发布")').first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
    } else {
      await page.locator('.Modal button:has-text("发布"), [role="dialog"] button:has-text("发布")').first().click();
    }
    await page.waitForTimeout(5000);

    // 发布后知乎跳转到文章页
    const url = page.url();
    const articleId = url.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/)?.[1];
    return { success: true, platformPostId: articleId, postUrl: url };
  }
}
