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
    const { context, page } = await this.ensureBrowser();
    try {
      await page.goto(this.loginUrl, { waitUntil: "networkidle" });
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const loggedIn = await this.checkLoggedIn(page).catch(() => false);
        if (loggedIn) {
          await this.saveCookies(context);
          return true;
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
