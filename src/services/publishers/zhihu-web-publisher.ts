import { PlaywrightPublisher } from "./playwright-publisher.js";
import { planImageInsertions } from "./wechat-official-publisher.js";
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

  /**
   * 在编辑器当前光标处上传一张插图。
   * 定位不到上传入口或上传失败时返回 false（降级纯文本，不中断发布）。
   */
  private async insertImage(page: Page, imagePath: string): Promise<boolean> {
    try {
      const fileInput = page
        .locator('input[type="file"][accept*="image"], input[type="file"]')
        .first();
      if ((await fileInput.count()) === 0) return false;
      await fileInput.setInputFiles(imagePath);
      // 等待知乎完成图片上传并插入编辑器
      await page.waitForTimeout(3000);
      return true;
    } catch {
      return false;
    }
  }

  /** 关掉编辑器上的浮层（新功能气泡/创作助手/弹窗）,否则遮挡点击导致 locator.click 超时(2026-08-06 实证) */
  private async dismissOverlays(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => {});
    const closers = page.locator(
      '[aria-label="关闭"], .Modal-closeButton, .css-1b83hw0, button:has-text("我知道了"), .Popover [class*="close"], [class*="Guide"] [class*="close"], [class*="assistant"] [class*="close"], [class*="Assistant"] [class*="close"]',
    );
    for (let i = 0; i < 3; i++) {
      const btn = closers.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
      } else break;
    }
    // 创作助手面板右上 ✕
    const assistantClose = page.locator('[class*="creator-assistant"] [class*="close"], div:has(> :text("创作助手")) [class*="close"]').first();
    if (await assistantClose.isVisible().catch(() => false)) {
      await assistantClose.click().catch(() => {});
    }
  }

  /** 受控点击编辑器:普通点击被浮层拦截时降级 force click(编辑器聚焦不需要通过命中测试) */
  private async clickEditor(box: ReturnType<Page["locator"]>): Promise<void> {
    try {
      await box.click({ timeout: 8000 });
    } catch {
      await this.dismissOverlays(box.page());
      await box.click({ force: true });
    }
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await this.dismissOverlays(page);

    const content =
      (input.options?.content as string) ??
      (input.options?.description as string) ??
      "";
    const title = (input.options?.articleTitle as string) ?? input.title;
    const contentImages = Array.isArray(input.options?.contentImages)
      ? (input.options.contentImages as unknown[]).filter(
          (p): p is string => typeof p === "string" && p.length > 0
        )
      : [];

    // 填写标题（知乎编辑器标题是 textarea）
    const titleBox = page.locator('textarea[placeholder*="标题"], input[placeholder*="标题"]').first();
    await titleBox.click();
    await titleBox.fill(title);

    // 填写正文（知乎编辑器正文是 contenteditable 区域）
    const contentBox = page.locator('.public-DraftEditor-content, div[contenteditable="true"]').first();
    await this.clickEditor(contentBox);
    // 逐行输入，换行转成编辑器内段落；按插图计划在段落间上传素材图
    const lines = content.split(/\r?\n/);
    const insertAfter = planImageInsertions(lines.length, contentImages.length);
    let imgIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await page.keyboard.type(lines[i], { delay: 5 });
      const wantImage = insertAfter.includes(i) && imgIdx < contentImages.length;
      let paragraphBreakPending = i < lines.length - 1;
      if (wantImage) {
        // 先换出一个空段落承接图片，上传成功后再换行继续输入后续文字
        await page.keyboard.press("Enter");
        const inserted = await this.insertImage(page, contentImages[imgIdx]);
        if (inserted) {
          imgIdx++;
          await this.clickEditor(contentBox);
          if (paragraphBreakPending) {
            await page.keyboard.press("Enter");
            paragraphBreakPending = false;
          }
        }
        // 上传入口不可用/失败：已换行一次，保持纯文本流程继续
        else {
          paragraphBreakPending = false;
        }
      }
      if (paragraphBreakPending) await page.keyboard.press("Enter");
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
    await page.waitForTimeout(2000);

    // 发布后知乎跳转到文章页（zhuanlan.zhihu.com/p/<id>）。
    // 真实校验：拿不到文章 ID 一律按失败处理 —— 此前无条件 success 属于假成功。
    await page.waitForURL(/zhuanlan\.zhihu\.com\/p\/\d+/, { timeout: 30000 }).catch(() => {});
    const url = page.url();
    const articleId = url.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/)?.[1];
    if (!articleId) {
      const errText = await page.locator("text=/发布失败|审核不通过|包含违规|不符合/").first().textContent().catch(() => null);
      return {
        success: false,
        error: errText
          ? `知乎发布被平台拒绝：${errText.trim()}`
          : "知乎发布结果无法确认（未跳转到文章页），已按失败处理。请到知乎创作中心人工确认后重试。",
      };
    }
    return { success: true, platformPostId: articleId, postUrl: url };
  }
}
