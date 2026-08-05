import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page } from "playwright";

/**
 * 视频号网页发布器（Playwright 浏览器自动化）。
 *
 * 视频号助手（channels.weixin.qq.com）是腾讯官方网页工具，扫码登录后即可
 * 网页发表视频动态，与抖音/小红书/知乎共用同一套「浏览器登录 → Cookie 入库
 * → 自动化发布」链路，取代此前从未接通的影刀 RPA 方案。
 *
 * 凭证：session_cookie（视频号助手登录 Cookie JSON 数组）。
 */
export class ChannelsWebPublisher extends PlaywrightPublisher {
  readonly platform = "channels";
  readonly name = "视频号网页发布";
  readonly loginUrl = "https://channels.weixin.qq.com/login.html";
  readonly uploadUrl = "https://channels.weixin.qq.com/platform/post/create";

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    return !page.url().includes("login");
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // 上传视频
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(input.videoPath);

    // 等待上传完成（进度条消失或出现封面帧，视频越大越慢）
    await page.waitForSelector('[class*="upload-progress"], [class*="progress-ing"]', {
      state: "hidden",
      timeout: 300000,
    }).catch(() => {});
    await page.waitForTimeout(3000);

    // 填写描述（视频号助手描述框是 contenteditable）
    const desc = (input.options?.description as string) ?? input.title;
    const descBox = page.locator('div[contenteditable="true"]').first();
    await descBox.click();
    await descBox.fill(desc);

    // 添加话题（描述框内输入 #话题 并选中联想项）
    if (input.options?.tags && Array.isArray(input.options.tags)) {
      for (const tag of (input.options.tags as string[]).slice(0, 5)) {
        await page.keyboard.type(` #${tag}`, { delay: 30 });
        await page.waitForTimeout(1000);
        const suggestion = page.locator('[class*="topic"] [class*="item"], [class*="hash"] li').first();
        if (await suggestion.count() > 0) {
          await suggestion.click();
        } else {
          await page.keyboard.press("Enter");
        }
      }
    }

    // 发表
    await page.locator('button:has-text("发表")').first().click();
    await page.waitForTimeout(5000);

    return { success: true, postUrl: page.url() };
  }
}
