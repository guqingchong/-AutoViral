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
    // 视频号控制台/微前端初始化慢(实测 10-30s),只等 2s 会把加载中的
    // 空白页/登录墙残影误判为未登录——扫码验证阶段因此被弹回二维码
    // (2026-08-07 实测)。改为 15s 内轮询:出现登录墙→false;
    // 出现已登录信号(发表/上传入口)→true;超时按当前页面文本判定。
    const deadline = Date.now() + 15000;
    let wallSince = 0;
    while (Date.now() < deadline) {
      if (page.url().includes("login")) return false;
      const loginWall = await page.locator("text=/登录视频号助手|扫码登录|微信扫码/").count().catch(() => 0);
      if (loginWall > 0) {
        // 握手过渡期登录墙可能短暂渲染后消失:持续 3s 以上才认作真未登录
        if (wallSince === 0) wallSince = Date.now();
        else if (Date.now() - wallSince > 3000) return false;
      } else {
        wallSince = 0;
      }
      const signedIn = await page.locator("text=/发表动态|视频描述|上传视频|选择视频/").count().catch(() => 0);
      if (signedIn > 0) return true;
      await page.waitForTimeout(1000);
    }
    console.log(`[login:channels] checkLoggedIn 15s 超时,按未登录处理 url=${page.url()}`);
    return false;
  }

  /**
   * 轮询等待文件输入出现(最长 maxMs),返回所在 frame。
   * wujie 沙箱下 Playwright 选择器引擎(frame.$/locator/waitForSelector)对
   * 微前端内容全部失效:evaluate 里 querySelectorAll 明明有 1 个 input,
   * frame.$ 却返回 null、evaluateHandle 句柄被判 detached(2026-08-07 实测)。
   * 因此探测与后续所有交互都必须走 frame.evaluate 原生 JS。
   */
  private async waitFileInput(page: Page, maxMs = 120_000): Promise<Frame | null> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        if (frame.isDetached()) continue;
        const count = await frame
          .evaluate(() => document.querySelectorAll('input[type="file"]').length)
          .catch(() => 0);
        if (count > 0) return frame;
      }
      await page.waitForTimeout(2000);
    }
    return null;
  }

  /**
   * 经 frame.evaluate 把视频文件注入文件输入(绕开 wujie 沙箱)。
   * 文件分块 base64 传入页面,JS 侧拼装 File + DataTransfer 赋值并派发
   * input/change 事件。已在诊断脚本实测:1.5MB 视频注入后页面正常出封面。
   */
  private async injectFile(frame: Frame, videoPath: string): Promise<boolean> {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const buf = await readFile(videoPath);
    const b64 = buf.toString("base64");
    const name = basename(videoPath);
    const CHUNK = 8 * 1024 * 1024;
    await frame.evaluate(() => { (window as unknown as { __up: string[] }).__up = []; });
    for (let off = 0; off < b64.length; off += CHUNK) {
      await frame.evaluate((p: string) => {
        (window as unknown as { __up: string[] }).__up.push(p);
      }, b64.slice(off, off + CHUNK));
    }
    const result = await frame.evaluate((fileName: string) => {
      const w = window as unknown as { __up?: string[] };
      const b64 = (w.__up ?? []).join("");
      delete w.__up;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileName, { type: "video/mp4" });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (!input) return "no-input";
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return `ok files=${input.files.length} size=${input.files[0]?.size ?? 0}`;
    }, name);
    return String(result).startsWith("ok");
  }

  /** frame 内文本轮询(登录墙/弹窗/结果提示),evaluate 实现绕开 wujie */
  private async frameText(frame: Frame): Promise<string> {
    return frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  }

  /** frame 内按文本点击按钮(evaluate 实现) */
  private async clickButtonByText(frame: Frame, texts: string[]): Promise<boolean> {
    return frame.evaluate((list: string[]) => {
      const btns = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const t of list) {
        const btn = btns.find((b) => (b.textContent ?? "").trim().includes(t));
        if (btn) { (btn as HTMLElement).click(); return true; }
      }
      return false;
    }, texts).catch(() => false);
  }

  protected override async doUpload(page: Page, input: PublishInput): Promise<PublishOutput> {
    // 不在已就位的情况下重复 goto:checkLoggedIn 刚把页面导航到本 URL,
    // 微前端初始化途中二次 goto 会把 wujie frame 卡成"有 frame 无内容"
    // 的死状态(input 永不出现,2026-08-07 实测复现)。仅当不在目标页时才导航。
    if (!page.url().startsWith(this.uploadUrl)) {
      await page.goto(this.uploadUrl, { waitUntil: "domcontentloaded" });
    }

    // 微前端偶发"页面初始化中"挂起:文件输入 120 秒不出现时重载页面重试一次(2026-08-06 实证)
    let frame = await this.waitFileInput(page);
    if (!frame) {
      await page.reload({ waitUntil: "domcontentloaded" });
      frame = await this.waitFileInput(page);
    }
    if (!frame) {
      return { success: false, error: "视频号发表页微前端加载超时（重载后文件输入仍未出现）" };
    }
    await this.clickButtonByText(frame, ["我知道了", "取消", "暂不"]);

    // 上传视频(JS 注入,wujie 沙箱下唯一可靠路径)
    const injected = await this.injectFile(frame, input.videoPath);
    if (!injected) {
      return { success: false, error: "视频注入文件输入失败（页面无可用 input）" };
    }

    // 等待上传真正完成:进度条/"取消上传"/封面"生成中"全部消失,且出现
    // 成品操作(删除按钮)。旧判定只看"封面预览"标签 —— 该标签上传中也存在,
    // 导致上传 14% 就点发表,点击被吞,60s 超时假失败(2026-08-07 实测)。
    const uploadDeadline = Date.now() + 300_000;
    let uploadDone = false;
    while (Date.now() < uploadDeadline) {
      const text = await this.frameText(frame);
      const uploading = /取消上传|生成中|上传中/.test(text);
      const ready = /删除/.test(text) && /视频描述/.test(text);
      if (!uploading && ready) { uploadDone = true; break; }
      await page.waitForTimeout(3000);
    }
    if (!uploadDone) {
      return { success: false, error: "视频号视频上传 5 分钟未完成（进度条未消失）" };
    }
    await this.clickButtonByText(frame, ["我知道了", "取消", "暂不"]);

    // 填写描述 + 话题(直接写入文本,不再依赖联想下拉)
    const desc = (input.options?.description as string) ?? input.title;
    const tags = Array.isArray(input.options?.tags) ? (input.options.tags as string[]).slice(0, 5) : [];
    const fullDesc = tags.length > 0 ? `${desc}\n${tags.map((t) => `#${t}`).join(" ")}` : desc;
    const descFilled = await frame.evaluate((text: string) => {
      const box = document.querySelector(
        'textarea[placeholder*="描述"], [data-placeholder*="描述"], div[contenteditable="true"]',
      ) as HTMLElement | null;
      if (!box) return false;
      box.focus();
      if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(
          box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(box, text);
      } else {
        box.innerText = text;
      }
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, fullDesc).catch(() => false);
    if (!descFilled) {
      return { success: false, error: "视频描述框填写失败（未找到描述输入元素）" };
    }
    await page.waitForTimeout(1000);

    // 发表 + 可能的二次确认。首次点击若被吞(上传刚完成按钮状态未刷新),
    // 10s 后仍在原页则补点一次。
    await this.clickButtonByText(frame, ["发表"]);
    await page.waitForTimeout(3000);
    await this.clickButtonByText(frame, ["确定", "确认", "发表"]);
    await page.waitForTimeout(7000);
    if (page.url().includes("post/create")) {
      const text = await this.frameText(frame);
      if (!/发表成功|发布成功|审核中/.test(text)) {
        await this.clickButtonByText(frame, ["发表"]);
        await page.waitForTimeout(2000);
        await this.clickButtonByText(frame, ["确定", "确认", "发表"]);
      }
    }

    // 真实校验发布结果:跳转动态列表/成功提示 → 成功;错误提示 → 失败;超时按失败。
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (/platform\/post\/list|platform\/home/.test(page.url())) {
        return { success: true, postUrl: page.url() };
      }
      const text = await this.frameText(frame);
      if (/发表成功|发布成功|提交成功|审核中/.test(text)) {
        return { success: true, postUrl: page.url() };
      }
      const failMatch = text.match(/发表失败|发布失败|上传失败|审核不通过|包含违规|不符合[^。]*/);
      if (failMatch) {
        return { success: false, error: `视频号发布被平台拒绝：${failMatch[0]}` };
      }
      await page.waitForTimeout(2000);
    }
    return {
      success: false,
      error: "视频号发布结果无法确认（60 秒内未出现成功提示或页面跳转），已按失败处理。请到视频号助手人工确认后重试。",
    };
  }
}
