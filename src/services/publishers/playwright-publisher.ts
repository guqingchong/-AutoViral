import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { type Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { getCredential, setCredential } from "../../db/platform-credentials-repo.js";

export interface PlaywrightOptions {
  headless?: boolean;
  slowMo?: number;
  userDataDir?: string;
}

export abstract class PlaywrightPublisher implements Publisher {
  protected options: PlaywrightOptions;
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;

  constructor(options: PlaywrightOptions = {}) {
    this.options = options;
  }

  abstract readonly platform: string;
  abstract readonly name: string;
  abstract readonly loginUrl: string;
  abstract readonly uploadUrl: string;

  async isConfigured(): Promise<boolean> {
    const cred = getCredential(this.platform, "session_cookie");
    if (!cred) return false;
    try {
      const cookies = JSON.parse(cred);
      return Array.isArray(cookies) && cookies.length > 0;
    } catch {
      return false;
    }
  }

  async ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.options.headless ?? true,
        slowMo: this.options.slowMo,
      });
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        userAgent: this.getUserAgent(),
        viewport: { width: 1280, height: 800 },
      });
      const cred = getCredential(this.platform, "session_cookie");
      if (cred) {
        try {
          const cookies = JSON.parse(cred);
          if (Array.isArray(cookies)) await this.context.addCookies(cookies);
        } catch { /* malformed cookie — ignore */ }
      }
    }
    const page = await this.context.newPage();
    return { browser: this.browser, context: this.context, page };
  }

  protected getUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  }

  protected abstract checkLoggedIn(page: Page): Promise<boolean>;
  protected abstract doUpload(page: Page, input: PublishInput): Promise<PublishOutput>;

  async publish(input: PublishInput): Promise<PublishOutput> {
    const { context, page } = await this.ensureBrowser();
    try {
      const loggedIn = await this.checkLoggedIn(page);
      if (!loggedIn) {
        return {
          success: false,
          error: `未登录 ${this.name}，请先在发布中心完成登录。`,
        };
      }
      const result = await this.doUpload(page, input);
      if (result.success) await this.saveCookies(context);
      return result;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await page.close();
      await this.close();
    }
  }

  async login(): Promise<boolean> {
    // 登录必须打开可见浏览器（用户要扫码/输密码），强制有头模式
    this.options = { ...this.options, headless: false };
    const { context, page } = await this.ensureBrowser();
    try {
      // 用 domcontentloaded 而非 networkidle：扫码登录页有长轮询，networkidle 永远不触发
      await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
      const loginStartUrl = page.url();
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        // 原地判断 URL，不主动跳转：扫码成功后登录页会自己跳转到控制台，
        // 若此时 goto 上传页会打断登录握手（ticket 换 cookie 发生在跳转过程中），
        // 导致永远被弹回二维码页（"不停刷新"现象）。
        // 注意：loginUrl 本身不一定含 login 字样（如抖音是 creator.douyin.com/），
        // 必须把起始登录页 URL 也视为"仍在登录页"——否则第一轮循环就会
        // checkLoggedIn→goto(上传页),每 2 秒刷新一次页面,用户根本扫不了码
        // (2026-08-06 实测复现)。
        const url = page.url();
        const stillOnLogin =
          url === loginStartUrl || /login|signin|passport/i.test(url);
        if (!stillOnLogin) {
          // URL 已离开登录页，再跳上传页二次确认登录态真实有效
          const loggedIn = await this.checkLoggedIn(page).catch(() => false);
          if (loggedIn) {
            await this.saveCookies(context);
            return true;
          }
          // 验证失败:回到登录页继续等用户扫码,绝不能留在上传页反复刷新
          await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        }
        await page.waitForTimeout(2000);
      }
      return false;
    } catch {
      return false;
    } finally {
      await page.close();
      await this.close();
    }
  }

  protected async saveCookies(context: BrowserContext): Promise<void> {
    const cookies = await context.cookies();
    setCredential(this.platform, "session_cookie", JSON.stringify(cookies));
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    await this.browser?.close();
    this.browser = null;
  }
}
