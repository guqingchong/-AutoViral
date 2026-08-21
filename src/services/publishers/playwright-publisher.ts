import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { type Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { setCredential } from "../../db/platform-credentials-repo.js";
import { setAccountCredential } from "../../db/account-credentials-repo.js";
import { resolveAccountCredential } from "../credential-resolver.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../../config.js";

export interface PlaywrightOptions {
  headless?: boolean;
  slowMo?: number;
  userDataDir?: string;
}

/**
 * 浏览器画像目录(2026-08-21 多账号隔离):browser-profiles/<platform>/<accountKey>,
 * accountKey = accountId ?? "legacy"。旧目录 browser-profiles/<platform> 不迁移,
 * 各账号首次发布/登录时从账号凭证重新播种 cookie。
 */
export function resolveProfileDir(platform: string, accountId?: string): string {
  return join(dataDir, "browser-profiles", platform, accountId ?? "legacy");
}

export abstract class PlaywrightPublisher implements Publisher {
  protected options: PlaywrightOptions;
  protected browser: Browser | null = null;
  /** 按账号隔离的 context 多实例:key = accountId ?? "legacy" */
  protected contexts = new Map<string, BrowserContext>();

  constructor(options: PlaywrightOptions = {}) {
    this.options = options;
  }

  abstract readonly platform: string;
  abstract readonly name: string;
  abstract readonly loginUrl: string;
  abstract readonly uploadUrl: string;

  async isConfigured(accountId?: string): Promise<boolean> {
    const cred = resolveAccountCredential(this.platform, accountId, "session_cookie");
    if (!cred) return false;
    try {
      const cookies = JSON.parse(cred);
      return Array.isArray(cookies) && cookies.length > 0;
    } catch {
      return false;
    }
  }

  async ensureBrowser(accountId?: string): Promise<{ browser: Browser | null; context: BrowserContext; page: Page }> {
    const key = accountId ?? "legacy";
    let context = this.contexts.get(key);
    if (!context) {
      // 每账号持久化浏览器画像:指纹(localStorage/IndexedDB)跨次稳定,
      // 避免微信系平台把"每次都是全新设备"判定为异常而强制下线
      // (视频号 cookie 4 小时内即失效的根因 —— 2026-08-07 实证)。
      // 首次启动画像为空时从账号凭证播种 cookie(历史兼容走 resolver 兜底链)。
      const profileDir = resolveProfileDir(this.platform, accountId);
      await mkdir(profileDir, { recursive: true });
      context = await chromium.launchPersistentContext(profileDir, {
        headless: this.options.headless ?? true,
        userAgent: this.getUserAgent(),
        viewport: { width: 1280, height: 800 },
      });
      this.contexts.set(key, context);
      const existing = await context.cookies();
      if (existing.length === 0) {
        const cred = resolveAccountCredential(this.platform, accountId, "session_cookie");
        if (cred) {
          try {
            const cookies = JSON.parse(cred);
            if (Array.isArray(cookies)) await context.addCookies(cookies);
          } catch { /* malformed cookie — ignore */ }
        }
      }
    }
    const page = await context.newPage();
    return { browser: this.browser, context, page };
  }

  protected getUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  }

  protected abstract checkLoggedIn(page: Page): Promise<boolean>;
  protected abstract doUpload(page: Page, input: PublishInput): Promise<PublishOutput>;

  async publish(input: PublishInput): Promise<PublishOutput> {
    const { context, page } = await this.ensureBrowser(input.accountId);
    try {
      const loggedIn = await this.checkLoggedIn(page);
      if (!loggedIn) {
        return {
          success: false,
          error: `未登录 ${this.name}，请先在发布中心完成登录。`,
        };
      }
      const result = await this.doUpload(page, input);
      if (result.success) await this.saveCookies(context, input.accountId);
      // 失败或结果无法确认时留现场截图,否则平台改版类问题无法定位
      if (!result.success) {
        const shot = await this.captureDebugSnapshot(page, input.workId);
        if (shot) result.error = `${result.error ?? "发布失败"}（现场截图: ${shot}）`;
      }
      return result;
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      const shot = await this.captureDebugSnapshot(page, input.workId);
      if (shot) msg += `（现场截图: ${shot}）`;
      return { success: false, error: msg };
    } finally {
      await page.close();
      await this.close();
    }
  }

  /** 发布失败现场截图,存到作品 output 目录;失败返回 null 不影响主流程 */
  protected async captureDebugSnapshot(page: Page, workId: string): Promise<string | null> {
    try {
      const dir = join(dataDir, "works", workId, "output");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `publish-debug-${this.platform}.png`);
      await page.screenshot({ path, timeout: 10000 });
      return path;
    } catch {
      return null;
    }
  }

  async login(accountId?: string): Promise<boolean> {
    // 登录必须打开可见浏览器（用户要扫码/输密码），强制有头模式。
    // 若已有无头持久画像在跑,先关掉再以有头模式重开同一画像(指纹一致)。
    this.options = { ...this.options, headless: false };
    await this.close();
    const { context, page } = await this.ensureBrowser(accountId);
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
          // URL 已离开登录页。但扫码成功后 ticket 换 cookie、控制台初始化需要时间
          // (视频号微前端实测 10-30s),立刻 goto 上传页验证会打断握手,把用户
          // 弹回二维码页造成"扫了又刷"死循环(2026-08-07 实测复现)。
          // 改为耐心验证:最长 60s 内每 8s 验证一次,期间不额外导航;
          // 若页面自己回到登录页(真失败)则立即退出验证,重新等扫码。
          console.log(`[login:${this.platform}] URL 离开登录页 → ${url}，开始耐心验证登录态`);
          const verifyDeadline = Date.now() + 60000;
          let verified = false;
          while (Date.now() < verifyDeadline) {
            const loggedIn = await this.checkLoggedIn(page).catch(() => false);
            console.log(`[login:${this.platform}] 验证结果=${loggedIn} url=${page.url()}`);
            if (loggedIn) {
              await this.saveCookies(context, accountId);
              return true;
            }
            const u = page.url();
            if (u === loginStartUrl || /login|signin|passport/i.test(u)) {
              console.log(`[login:${this.platform}] 页面自行回到登录页，判定验证失败，重新等待扫码`);
              break;
            }
            await page.waitForTimeout(8000);
          }
          if (!verified) {
            // 验证失败:回到登录页继续等用户扫码,绝不能留在上传页反复刷新
            await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
          }
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

  /**
   *  cookie 落库:指定账号时写 account_credentials(账号维度);
   *  同时保留旧 platform_credentials 写入(deprecated 兜底,accounts 路由登录桥依赖它)。
   */
  protected async saveCookies(context: BrowserContext, accountId?: string): Promise<void> {
    const cookies = await context.cookies();
    const serialized = JSON.stringify(cookies);
    if (accountId) setAccountCredential(accountId, "session_cookie", serialized);
    setCredential(this.platform, "session_cookie", serialized);
  }

  async close(): Promise<void> {
    for (const context of this.contexts.values()) {
      await context.close().catch(() => {});
    }
    this.contexts.clear();
    await this.browser?.close();
    this.browser = null;
  }
}
