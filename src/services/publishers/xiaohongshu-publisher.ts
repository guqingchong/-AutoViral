import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page } from "playwright";

export class XiaohongshuPublisher extends PlaywrightPublisher {
  readonly platform = "xiaohongshu";
  readonly name = "小红书创作服务平台";
  readonly loginUrl = "https://creator.xiaohongshu.com/login";
  readonly uploadUrl = "https://creator.xiaohongshu.com/publish/publish";

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    return !page.url().includes("/login");
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "networkidle" });

    // 选择「发布视频」
    await page.locator("text=发布视频").first().click();

    // 上传视频
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(input.videoPath);
    await page.waitForTimeout(3000);

    // 填写标题
    const titleInput = page.locator('input[placeholder*="标题"]').first();
    await titleInput.fill(input.title);

    // 填写正文
    if (input.options?.description) {
      const descBox = page.locator('div[contenteditable="true"]').first();
      await descBox.fill(String(input.options.description));
    }

    // 添加话题
    if (input.options?.tags && Array.isArray(input.options.tags)) {
      const tagInput = page.locator('input[placeholder*="话题"]').first();
      for (const tag of (input.options.tags as string[]).slice(0, 5)) {
        await tagInput.fill(`#${tag}`);
        await tagInput.press("Enter");
      }
    }

    // 发布
    await page.locator('button:has-text("发布")').first().click();
    await page.waitForTimeout(5000);

    return { success: true, postUrl: page.url() };
  }
}
