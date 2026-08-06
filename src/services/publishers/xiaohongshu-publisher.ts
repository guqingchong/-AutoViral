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
    // domcontentloaded + 显式等上传入口：创作者页有长轮询，networkidle 不可靠
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"]').first().waitFor({ state: "attached", timeout: 60000 });

    // 图文笔记（双产物图片卡片）：options.imagePaths 非空时走「上传图文」
    const imagePaths = Array.isArray(input.options?.imagePaths)
      ? (input.options.imagePaths as unknown[]).filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        )
      : [];

    if (imagePaths.length > 0) {
      // 选择「上传图文」Tab（新版创作页 Tab 为 .creator-tab 结构;
      // 旧 text=上传图文 会匹配到隐藏的侧边栏重复元素导致 click 超时 —— 2026-08-06 实证）
      await page.locator('.creator-tab:has-text("上传图文")').first().click();
      await page.waitForTimeout(1000);

      // 上传图片卡片（多图一次传入，顺序即展示顺序）
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(imagePaths);
      await page.waitForTimeout(3000);
    } else {
      // 视频:/publish/publish 默认就是「上传视频」Tab,无需点击
      // (旧流程点 text=发布视频,该入口在新版页面不存在 —— 2026-08-06 实证)。
      // 若默认 Tab 失效,兜底点击上传视频 Tab。
      let fileInput = page.locator('input[type="file"]').first();
      if ((await fileInput.count()) === 0) {
        await page.locator('.creator-tab:has-text("上传视频")').first().click();
        await page.waitForTimeout(1000);
        fileInput = page.locator('input[type="file"]').first();
      }
      await fileInput.setInputFiles(input.videoPath);
      await page.waitForTimeout(3000);
    }

    // 填写标题（小红书图文标题上限 20 字）
    const title = imagePaths.length > 0 ? input.title.slice(0, 20) : input.title;
    const titleInput = page.locator('input[placeholder*="标题"]').first();
    await titleInput.fill(title);

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
    await page.waitForTimeout(1500);

    // 可能的二次确认弹窗，出现则确认
    const confirmBtn = page.locator(
      'div[role="dialog"] button:has-text("发布"), div[role="dialog"] button:has-text("确定"), [class*="modal"] button:has-text("确定")',
    ).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click().catch(() => {});
    }

    // 真实校验发布结果 —— 此前点击后无条件返回成功（假成功）。
    // 成功信号：跳转成功页/笔记管理页 或 成功提示；失败信号：错误提示；超时按失败处理。
    const SUCCESS_TEXT = "text=/发布成功|提交成功|笔记审核中|审核中/";
    const FAILURE_TEXT = "text=/发布失败|上传失败|审核不通过|包含违规|不符合社区|暂不支持/";
    const outcome = await Promise.race([
      page.waitForURL(/publish\/success|source=success|note\/manage|\/creator\/home/, { timeout: 60000 }).then(() => "success" as const),
      page.locator(SUCCESS_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "success" as const),
      page.locator(FAILURE_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "failed" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "success") {
      return { success: true, postUrl: page.url() };
    }
    if (outcome === "failed") {
      const errText = await page.locator(FAILURE_TEXT).first().textContent().catch(() => null);
      return { success: false, error: `小红书发布被平台拒绝：${errText?.trim() ?? "未知错误"}` };
    }
    return {
      success: false,
      error: "小红书发布结果无法确认（60 秒内未出现成功提示或页面跳转），已按失败处理。请到小红书创作服务平台人工确认后重试。",
    };
  }
}
