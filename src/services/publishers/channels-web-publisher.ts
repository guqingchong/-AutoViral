import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page, Frame } from "playwright";

/**
 * 视频号网页发布器（Playwright 浏览器自动化）。
 *
 * 视频号助手（channels.weixin.qq.com）是腾讯官方网页工具，扫码登录后即可
 * 网页发表视频动态，与抖音/小红书/知乎共用同一套「浏览器登录 → Cookie 入库
 * → 自动化发布」链路，取代此前从未接通的影刀 RPA 方案。
 *
 * 凭证：session_cookie（视频号助手登录 Cookie JSON 数组）。
 *
 * 注意（2026-08-06 实证）：发表页 /platform/post/create 的内容渲染在
 * 无界（wujie）微前端 iframe 中（URL 含 /micro/content/post/create），
 * 且初始化需要 10-30 秒。所有表单元素必须在该 frame 内定位，
 * 在主页面 page.locator 会一律超时。
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

  /** 轮询等待微前端 frame 出现（wujie iframe 初始化慢，最长 90 秒） */
  private async waitMicroFrame(page: Page): Promise<Frame | null> {
    for (let i = 0; i < 45; i++) {
      const frame = page.frames().find((f) => f.url().includes("/micro/"));
      if (frame) return frame;
      await page.waitForTimeout(2000);
    }
    return null;
  }

  /** 关掉初始化期间可能弹出的引导/绑定弹窗（我知道了/取消），不强制 */
  private async dismissDialogs(frame: Frame): Promise<void> {
    for (const text of ["我知道了", "取消", "暂不"]) {
      const btn = frame.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await frame.waitForTimeout(500);
      }
    }
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });

    // 微前端偶发"页面初始化中"挂起:文件输入 90 秒不出现时重载页面重试一次(2026-08-06 实证)
    let frame = await this.waitMicroFrame(page);
    let attached = false;
    if (frame) {
      attached = await frame
        .waitForSelector('input[type="file"]', { state: "attached", timeout: 90000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!frame || !attached) {
      await page.reload({ waitUntil: "domcontentloaded" });
      frame = await this.waitMicroFrame(page);
      if (!frame) {
        return { success: false, error: "视频号发表页微前端加载超时（重载后 /micro/ frame 仍未出现）" };
      }
      await frame.waitForSelector('input[type="file"]', { state: "attached", timeout: 90000 });
    }
    await this.dismissDialogs(frame);

    // 上传视频
    const fileInput = frame.locator('input[type="file"][accept*="video"], input[type="file"]').first();
    await fileInput.setInputFiles(input.videoPath);

    // 等待上传完成（进度条消失或出现封面帧，视频越大越慢）
    await frame
      .waitForSelector('[class*="upload-progress"], [class*="progress-ing"]', {
        state: "hidden",
        timeout: 300000,
      })
      .catch(() => {});
    await frame.waitForTimeout(3000);
    await this.dismissDialogs(frame);

    // 填写描述（视频号新发表页「视频描述」框：textarea 或 contenteditable，按可见性兜底）
    const desc = (input.options?.description as string) ?? input.title;
    const descBox = frame
      .locator(
        'textarea[placeholder*="描述"], [data-placeholder*="描述"], input[placeholder*="描述"], div[contenteditable="true"]',
      )
      .first();
    await descBox.click();
    await descBox.fill(desc);

    // 添加话题（描述框内输入 #话题 并选中联想项）
    if (input.options?.tags && Array.isArray(input.options.tags)) {
      for (const tag of (input.options.tags as string[]).slice(0, 5)) {
        await page.keyboard.type(` #${tag}`, { delay: 30 });
        await frame.waitForTimeout(1000);
        const suggestion = frame.locator('[class*="topic"] [class*="item"], [class*="hash"] li').first();
        if ((await suggestion.count()) > 0) {
          await suggestion.click();
        } else {
          await page.keyboard.press("Enter");
        }
      }
    }

    // 发表
    await frame.locator('button:has-text("发表")').first().click();
    await frame.waitForTimeout(1500);

    // 可能的二次确认弹窗，出现则确认
    const confirmBtn = frame.locator(
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
      frame.locator(SUCCESS_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "success" as const),
      frame.locator(FAILURE_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "failed" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "success") {
      return { success: true, postUrl: page.url() };
    }
    if (outcome === "failed") {
      const errText = await frame.locator(FAILURE_TEXT).first().textContent().catch(() => null);
      return { success: false, error: `视频号发布被平台拒绝：${errText?.trim() ?? "未知错误"}` };
    }
    return {
      success: false,
      error: "视频号发布结果无法确认（60 秒内未出现成功提示或页面跳转），已按失败处理。请到视频号助手人工确认后重试。",
    };
  }
}
