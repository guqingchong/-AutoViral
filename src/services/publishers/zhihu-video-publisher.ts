import { PlaywrightPublisher } from "./playwright-publisher.js";
import type { PublishInput, PublishOutput } from "./types.js";
import type { Page } from "playwright";

/**
 * 知乎视频发布器（Playwright 浏览器自动化）。
 *
 * 与 ZhihuWebPublisher（写专栏文章,图文发布页用）对应,本发布器走
 * 知乎视频上传页 https://www.zhihu.com/upload-video,只发视频 ——
 * 2026-08-07「视频/图文分块发布」约定:视频发布页的知乎必须发视频,
 * 此前视频页点知乎发出的是专栏文章(实测"河北中考体育50分")。
 *
 * 凭证与文章发布器共用:session_cookie + 持久画像 browser-profiles/zhihu
 * （platform 同为 "zhihu",同一登录态）。
 *
 * 页面结构(2026-08-07 探查实证):
 * - input[type=file] 直接 setInputFiles 可用(无 wujie 沙箱);
 * - 标题 textarea[placeholder=标题](默认填文件名,需覆盖);
 * - 简介 div[contenteditable].public-DraftEditor-content;
 * - 上传完成信号:左侧上传列表出现"上传成功"/"视频上传中"消失;
 * - 视频标记(必填):button[aria-label=选择视频标记] 盖住下方 combobox,
 *   点开是"添加视频标记"弹窗 → 选"含 AI 生成内容"(AI 内容标识法规合规)
 *   → 点"确认";
 * - 发布:button.VideoUploadForm-submitButton(文本"发布视频")。
 */
export class ZhihuVideoPublisher extends PlaywrightPublisher {
  readonly platform = "zhihu";
  readonly name = "知乎视频发布";
  readonly loginUrl = "https://www.zhihu.com/signin";
  readonly uploadUrl = "https://www.zhihu.com/upload-video";

  protected override async checkLoggedIn(page: Page): Promise<boolean> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (/signin|login/.test(page.url())) return false;
    // 上传页特征文本;风控页在 doUpload 单独检测
    const marker = await page.locator("text=/拖放要上传的视频文件|上传视频|视频大小/").count().catch(() => 0);
    return marker > 0;
  }

  /** 知乎风控页检测(code 40362「请求存在异常,暂时限制本次访问」) */
  private async checkRiskControl(page: Page): Promise<PublishOutput | null> {
    const blocked = await page
      .locator("text=/请求存在异常|暂时限制本次访问|40362/")
      .count()
      .catch(() => 0);
    if (blocked > 0) {
      return {
        success: false,
        error:
          "知乎风控限制本次访问（40362，自动化请求过密触发）。请暂停 2-4 小时后重试；若持续被限，按页面提示手机摇一摇或登录后私信知乎小管家解除。",
      };
    }
    return null;
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const blocked = await this.checkRiskControl(page);
    if (blocked) return blocked;

    // 上传视频(setInputFiles 直传,知乎自研上传组件无沙箱)
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) return { success: false, error: "知乎视频上传页未找到文件输入（页面结构可能已改版）" };
    await fileInput.setInputFiles(input.videoPath);

    // 等表单出现并覆盖标题(默认填文件名)
    const titleBox = page.locator('textarea[placeholder="标题"]');
    await titleBox.waitFor({ timeout: 60000 });
    await titleBox.click();
    await titleBox.fill(input.title);

    // 填简介(可选):描述取 options.description,缺省用标题
    const desc = (input.options?.description as string) ?? "";
    if (desc) {
      const descBox = page.locator('[contenteditable="true"].public-DraftEditor-content, [contenteditable="true"]').first();
      if (await descBox.count() > 0) {
        await descBox.click();
        await page.keyboard.type(desc.slice(0, 500), { delay: 5 });
      }
    }

    // 等上传完成:"视频上传中"消失(大视频较慢,最长 5 分钟)
    const uploadDeadline = Date.now() + 300_000;
    let uploadDone = false;
    while (Date.now() < uploadDeadline) {
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (/上传成功/.test(text) || !/视频上传中/.test(text)) { uploadDone = true; break; }
      await page.waitForTimeout(3000);
    }
    if (!uploadDone) {
      return { success: false, error: "知乎视频上传 5 分钟未完成" };
    }

    // 视频标记(必填):合规选"含 AI 生成内容"(本系统视频为 AI 生成,
    // 《人工智能生成合成内容标识办法》要求标识);找不到该项则维持默认"内容无需标注"
    await page.locator('button[aria-label="选择视频标记"]').first().click().catch(async () => {
      await page.locator('button:has-text("选择标记")').first().click({ force: true });
    });
    await page.waitForTimeout(1500);
    const aiMark = page.locator('text=/^\\s*含 AI 生成内容\\s*$/').first();
    if (await aiMark.isVisible().catch(() => false)) {
      await aiMark.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.locator('button:has-text("确认")').first().click().catch(() => {});
    await page.waitForTimeout(1000);

    // 发布
    const submit = page.locator('button.VideoUploadForm-submitButton, button:text-is("发布视频")').first();
    if (await submit.isDisabled().catch(() => false)) {
      return { success: false, error: "知乎「发布视频」按钮不可用（必填项缺失,可能是封面未生成或标记未选）" };
    }
    await submit.click();
    await page.waitForTimeout(3000);

    const blockedAfter = await this.checkRiskControl(page);
    if (blockedAfter) return blockedAfter;

    // 真实校验:离开上传页(跳视频管理/创作中心)或成功提示 → 成功;
    // 失败提示 → 失败;超时按失败处理,不假成功。
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!page.url().includes("upload-video")) {
        return { success: true, postUrl: page.url() };
      }
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (/发布成功|提交成功|审核中|发布待审核/.test(text)) {
        return { success: true, postUrl: page.url() };
      }
      const failMatch = text.match(/发布失败|上传失败|审核不通过|包含违规|不符合[^。]*/);
      if (failMatch) {
        return { success: false, error: `知乎视频发布被平台拒绝：${failMatch[0]}` };
      }
      await page.waitForTimeout(2000);
    }
    return {
      success: false,
      error: "知乎视频发布结果无法确认（60 秒内未跳转且无成功提示），已按失败处理。请到知乎创作中心人工确认后重试。",
    };
  }
}
