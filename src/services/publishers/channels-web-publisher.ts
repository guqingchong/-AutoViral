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
    await page.waitForTimeout(1500);

    // 可能的二次确认弹窗，出现则确认
    const confirmBtn = page.locator(
      'div[role="dialog"] button:has-text("发表"), div[role="dialog"] button:has-text("确定"), [class*="modal"] button:has-text("确定")',
    ).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click().catch(() => {});
    }

    // 真实校验发布结果 —— 此前点击后无条件返回成功（假成功）。
    // 成功信号：跳转动态列表页 或 成功提示；失败信号：错误提示；超时按失败处理。
    const SUCCESS_TEXT = "text=/发表成功|发布成功|提交成功|审核中/";
    const FAILURE_TEXT = "text=/发表失败|发布失败|上传失败|审核不通过|包含违规|不符合/";
    const outcome = await Promise.race([
      page.waitForURL(/platform\/post\/list|platform\/home/, { timeout: 60000 }).then(() => "success" as const),
      page.locator(SUCCESS_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "success" as const),
      page.locator(FAILURE_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "failed" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "success") {
      return { success: true, postUrl: page.url() };
    }
    if (outcome === "failed") {
      const errText = await page.locator(FAILURE_TEXT).first().textContent().catch(() => null);
      return { success: false, error: `视频号发布被平台拒绝：${errText?.trim() ?? "未知错误"}` };
    }
    return {
      success: false,
      error: "视频号发布结果无法确认（60 秒内未出现成功提示或页面跳转），已按失败处理。请到视频号助手人工确认后重试。",
    };
  }
}
