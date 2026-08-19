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
    if (page.url().includes("/login")) return false;
    // 抖音会在上传 URL 原地渲染登录表单(不跳转),仅查 URL 会误判已登录(2026-08-06 实证)
    const loginForm = await page.locator("text=/扫码登录|验证码登录|我是创作者/").count().catch(() => 0);
    return loginForm === 0;
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    // domcontentloaded + 显式等上传入口：创作者页有长轮询，networkidle 经常永远不触发
    //（2026-08-06 实测：goto 30s 超时导致发布失败）
    await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });

    // 草稿提示处理:「你还有上次未发布的视频」条会干扰新上传(草稿只存文字
    // 不存视频,曾导致视频丢失型假成功 —— 2026-08-07 实测)。
    // 一律放弃旧草稿,从干净状态上传。注意入口是 span 不是 button。
    const draftDropped = await page.evaluate(() => {
      const giveUp = document.querySelector('span[class*="give-up"]');
      if (giveUp && giveUp.getClientRects().length > 0) { (giveUp as HTMLElement).click(); return true; }
      return false;
    }).catch(() => false);
    if (draftDropped) {
      // 放弃草稿可能有确认弹窗
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button"))
          .find((b) => /确定|放弃/.test(b.textContent ?? "") && !/取消/.test(b.textContent ?? ""));
        btn?.click();
      }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: "attached", timeout: 60000 });
    await fileInput.setInputFiles(input.videoPath);

    // 等待上传真正完成:进度百分比消失且出现"重新上传/更换视频"
    // (旧逻辑只等 progress 隐藏,上传未完成就填表点发布 → 草稿假成功)
    const uploadDeadline = Date.now() + 480_000;
    let uploadDone = false;
    while (Date.now() < uploadDeadline) {
      const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const uploading = /上传中|处理中|转码中|\d+%/.test(text);
      if (!uploading && /重新上传|更换视频/.test(text)) { uploadDone = true; break; }
      await page.waitForTimeout(4000);
    }
    if (!uploadDone) {
      return { success: false, error: "抖音视频上传 8 分钟未完成（进度未消失）" };
    }

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

    // 自主声明:选"内容由AI生成"(本系统视频为 AI 生成,平台规则要求声明;
    // 弹窗内精确匹配,避免误点导航"AI分身" —— 2026-08-07 实测踩坑)
    await page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll('[class*="select"], [role="combobox"], [class*="Select"]'))
        .find((e) => /请选择自主声明/.test(e.textContent ?? "") && (e.textContent ?? "").length < 30);
      if (sel) (sel as HTMLElement).click();
    }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const dialog = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'))
        .find((d) => /声明类型/.test(d.textContent ?? "") && d.getClientRects().length > 0);
      if (!dialog) return;
      const opt = Array.from(dialog.querySelectorAll("label, span, div"))
        .find((e) => (e.textContent ?? "").trim() === "内容由AI生成");
      if (opt) (opt as HTMLElement).click();
    }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const dialog = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'))
        .find((d) => /声明类型/.test(d.textContent ?? "") && d.getClientRects().length > 0);
      const btn = dialog && Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent.trim() === "确定");
      btn?.click();
    }).catch(() => {});
    await page.waitForTimeout(1500);

    // 点击发布：必须用精确文本匹配 —— button:has-text("发布") 会先命中左侧导航的
    // 「作品发布」菜单按钮(.first()),根本没提交,等 60 秒成功信号只能超时
    // (2026-08-06 实测复现:同一流程 .last()/text-is 点击后 6 秒跳内容管理页)
    await page.locator('button:text-is("发布")').first().click();
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
    // 成功信号：跳转内容管理页 / 出现成功提示；失败信号：错误提示；超时按失败处理并留现场截图。
    const SUCCESS_TEXT = "text=/发布成功|提交成功|已发布|审核中|作品已发布|发布至抖音|已提交审核/";
    const FAILURE_TEXT = "text=/发布失败|上传失败|审核不通过|包含违规|不符合社区|暂不支持/";
    const outcome = await Promise.race([
      page.waitForURL(/content\/manage|content\/post|creator-micro\/home/, { timeout: 60000 }).then(() => "success" as const),
      page.locator(SUCCESS_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "success" as const),
      page.locator(FAILURE_TEXT).first().waitFor({ state: "visible", timeout: 60000 }).then(() => "failed" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "success") {
      // 2026-08-19 P2:best-effort 解析 platformPostId(内容管理页最新作品链接含 /video/<id>),
      // 用于发布后指标回流;页面结构变动时返回 undefined,不影响发布本身
      let platformPostId: string | undefined;
      try {
        platformPostId = await page.evaluate(() => {
          const a = document.querySelector('a[href*="/video/"]');
          return a?.getAttribute("href")?.match(/\/video\/(\d+)/)?.[1];
        });
      } catch { /* 解析失败不阻断 */ }
      // 审核中信号判定:成功提示含"审核"字样 → reviewing(由对账任务转正/转拒)
      const reviewing = await page.locator("text=/审核中|已提交审核/").first().isVisible().catch(() => false);
      return { success: true, postUrl: page.url(), platformPostId, reviewing };
    }
    if (outcome === "failed") {
      const errText = await page.locator(FAILURE_TEXT).first().textContent().catch(() => null);
      return { success: false, error: `抖音发布被平台拒绝：${errText?.trim() ?? "未知错误"}` };
    }
    return {
      success: false,
      error: `抖音发布结果无法确认（60 秒内未跳转内容管理页、也未出现成功提示，最后停留在 ${page.url()}），已按失败处理。请到抖音创作者中心人工确认后重试。`,
    };
  }
}
