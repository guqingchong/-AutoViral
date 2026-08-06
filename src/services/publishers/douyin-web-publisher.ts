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
    // domcontentloaded + 显式等上传入口：创作者页有长轮询，networkidle 经常永远不触发
    //（2026-08-06 实测：goto 30s 超时导致发布失败）
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 60000 });
    await fileInput.setInputFiles(input.videoPath);

    // 等待上传进度出现并稳定
    await page.waitForSelector('.upload-progress, [class*="progress"]', { state: "hidden", timeout: 120000 }).catch(() => {});

    // 填写标题：选择首个可编辑 div（等它真正出现，上传未完成时不可见）
    const titleBox = page.locator('div[contenteditable="true"]').first();
    await titleBox.waitFor({ state: "visible", timeout: 120000 });
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
    await page.waitForTimeout(1500);

    // 可能的二次确认弹窗（声明/同步设置等），出现则确认
    const confirmBtn = page.locator(
      'div[role="dialog"] button:has-text("发布"), div[role="dialog"] button:has-text("确定"), [class*="modal"] button:has-text("确定")',
    ).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click().catch(() => {});
    }

    // 真实校验发布结果 —— 此前点击"发布"后无条件返回成功，导致
    // 平台显示已发布而实际未发布（2026-08-06 用户实测复现）。
    // 成功信号：跳转内容管理页 / 出现成功提示；失败信号：错误提示；超时一律按失败处理。
    const SUCCESS_TEXT = "text=/发布成功|提交成功|已发布|审核中/";
    const FAILURE_TEXT = "text=/发布失败|上传失败|审核不通过|包含违规|不符合社区|暂不支持/";
    const outcome = await Promise.race([
      page.waitForURL(/content\/manage|content\/post/, { timeout: 60000 }).then(() => "success" as const),
      page.locator(SUCCESS_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "success" as const),
      page.locator(FAILURE_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "failed" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "success") {
      return { success: true, postUrl: page.url() };
    }
    if (outcome === "failed") {
      const errText = await page.locator(FAILURE_TEXT).first().textContent().catch(() => null);
      return { success: false, error: `抖音发布被平台拒绝：${errText?.trim() ?? "未知错误"}` };
    }
    return {
      success: false,
      error: "抖音发布结果无法确认（60 秒内未跳转内容管理页、也未出现成功提示），已按失败处理。请到抖音创作者中心人工确认后重试。",
    };
  }
}
