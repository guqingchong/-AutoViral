import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page } from "playwright";

export class DouyinWebPublisher extends PlaywrightPublisher {
  readonly platform = "douyin";
  readonly name = "抖音网页上传";
  readonly loginUrl = "https://creator.douyin.com/";
  readonly uploadUrl = "https://creator.douyin.com/creator-micro/content/upload";

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    // domcontentloaded + 短等待：创作者页有长轮询，networkidle 不可靠
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    return !page.url().includes("/login");
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "networkidle" });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(input.videoPath);

    // 等待上传进度出现并稳定
    await page.waitForSelector('.upload-progress, [class*="progress"]', { state: "hidden", timeout: 120000 }).catch(() => {});

    // 填写标题：选择首个可编辑 div
    const titleBox = page.locator('div[contenteditable="true"]').first();
    await titleBox.fill(input.title);

    // 添加话题标签
    if (input.options?.tags && Array.isArray(input.options.tags)) {
      const tagInput = page.locator('input[placeholder*="话题"], input[placeholder*="标签"]').first();
      for (const tag of (input.options.tags as string[]).slice(0, 5)) {
        await tagInput.fill(`#${tag}`);
        await tagInput.press("Enter");
      }
    }

    // 点击发布
    await page.locator('button:has-text("发布")').first().click();
    await page.waitForTimeout(5000);

    const url = page.url();
    return { success: true, postUrl: url };
  }
}
