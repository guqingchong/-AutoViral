import { chromium, type Browser } from "playwright";
import { getCredential } from "../db/platform-credentials-repo.js";
import { dataDir } from "../config.js";
import { join } from "node:path";

/**
 * 各平台登录态健康检查。
 *
 * 「发布就绪」只代表凭证存在，Cookie 会过期——本模块实测凭证是否仍然有效：
 * - RPA 平台（抖音/小红书/视频号/知乎）：共享一个无头浏览器，带 Cookie 访问
 *   发布页，被重定向到登录页即判定失效；
 * - 公众号/快手：调各自 OAuth token 接口；
 * - B站：带 SESSDATA 调 nav 接口看 isLogin。
 *
 * 结果带 10 分钟内存缓存，避免每次打开发布中心都实测一遍。
 */

export interface PlatformHealth {
  platform: string;
  /** 凭证存在 */
  configured: boolean;
  /** 凭证实测有效；未配置时为 null */
  valid: boolean | null;
  detail: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const RPA_CHECKS: Record<string, { url: string; loginPattern: RegExp; loginContentPattern?: RegExp }> = {
  // 抖音现在会在上传 URL 原地渲染登录表单(不跳转 /login),仅查 URL 会误判有效(2026-08-06 实证)
  douyin: { url: "https://creator.douyin.com/creator-micro/content/upload", loginPattern: /\/login/, loginContentPattern: /扫码登录|验证码登录|我是创作者/ },
  xiaohongshu: { url: "https://creator.xiaohongshu.com/publish/publish", loginPattern: /\/login/ },
  // channels 不在此表:微信把会话绑在设备指纹上,必须用持久画像检测(见 verifyChannels)
  zhihu: { url: "https://zhuanlan.zhihu.com/write", loginPattern: /signin|login/ },
};

/**
 * 视频号专用健康检查:复用发布器的持久画像(browser-profiles/channels)。
 * 微信系把登录会话绑在设备指纹(localStorage/IndexedDB)上,全新无头上下文
 * 只带 cookie 会被判"新设备"而弹登录墙 —— 扫码刚成功、画像内会话有效,
 * 裸 cookie 检测却报失效(2026-08-07 实测)。与 ChannelsWebPublisher.checkLoggedIn
 * 同标准:登录墙持续 3s+ → 失效;出现已登录信号 → 有效。
 */
async function verifyChannels(): Promise<PlatformHealth> {
  const platform = "channels";
  const raw = getCredential(platform, "session_cookie");
  if (!raw) return { platform, configured: false, valid: null, detail: "未配置 Cookie" };
  const profileDir = join(dataDir, "browser-profiles", platform);
  let context: import("playwright").BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto("https://channels.weixin.qq.com/platform/post/create", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const deadline = Date.now() + 20000;
    let wallSince = 0;
    while (Date.now() < deadline) {
      if (page.url().includes("login")) {
        return { platform, configured: true, valid: false, detail: "登录态已失效，请重新浏览器登录" };
      }
      const wall = await page.locator("text=/登录视频号助手|扫码登录|微信扫码/").count().catch(() => 0);
      if (wall > 0) {
        if (wallSince === 0) wallSince = Date.now();
        else if (Date.now() - wallSince > 3000) {
          return { platform, configured: true, valid: false, detail: "登录态已失效，请重新浏览器登录" };
        }
      } else {
        wallSince = 0;
      }
      const signedIn = await page.locator("text=/发表动态|视频描述|上传视频|选择视频/").count().catch(() => 0);
      if (signedIn > 0) {
        // 画像内 cookie 可能已刷新,顺便回写凭证库保持同步
        const cookies = await context.cookies();
        const { setCredential } = await import("../db/platform-credentials-repo.js");
        setCredential(platform, "session_cookie", JSON.stringify(cookies));
        return { platform, configured: true, valid: true, detail: "登录态有效" };
      }
      await page.waitForTimeout(1000);
    }
    return { platform, configured: true, valid: null, detail: "检测超时：发表页 20 秒内未完成初始化，请重试" };
  } catch (err) {
    return { platform, configured: true, valid: null, detail: `检测失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function verifyRpa(platform: string, browser: Browser): Promise<PlatformHealth> {
  const check = RPA_CHECKS[platform];
  const raw = getCredential(platform, "session_cookie");
  if (!raw) return { platform, configured: false, valid: null, detail: "未配置 Cookie" };
  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    return { platform, configured: true, valid: false, detail: "Cookie 不是 JSON 数组格式，请用浏览器登录重新入库" };
  }
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { platform, configured: true, valid: false, detail: "Cookie 为空" };
  }
  try {
    const context = await browser.newContext({ userAgent: UA });
    await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
    const page = await context.newPage();
    await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    const finalUrl = page.url();
    // 内容级判定:登录表单可能原地渲染而不跳转 URL(text=/.../ 为正则选择器)。
    // 抖音登录表单要 5-8 秒才渲染,短等待会误判有效 —— 轮询最长 15 秒(2026-08-06 实证)
    let contentIsLogin = false;
    if (check.loginContentPattern) {
      for (let i = 0; i < 11 && !contentIsLogin; i++) {
        contentIsLogin =
          (await page.locator(`text=/${check.loginContentPattern.source}/`).count().catch(() => 0)) > 0;
        if (!contentIsLogin) await page.waitForTimeout(1500);
      }
    }
    await context.close();
    if (check.loginPattern.test(finalUrl) || contentIsLogin) {
      return { platform, configured: true, valid: false, detail: "登录态已失效，请重新浏览器登录" };
    }
    return { platform, configured: true, valid: true, detail: "登录态有效" };
  } catch (err) {
    return { platform, configured: true, valid: null, detail: `检测失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function verifyWechat(): Promise<PlatformHealth> {
  const platform = "wechat";
  const appId = getCredential("wechat", "app_id");
  const appSecret = getCredential("wechat", "app_secret");
  if (!appId || !appSecret) return { platform, configured: false, valid: null, detail: "未配置 AppID/AppSecret" };
  try {
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
    );
    const data = (await res.json()) as { access_token?: string; errcode?: number; errmsg?: string };
    if (data.access_token) return { platform, configured: true, valid: true, detail: "AppID/AppSecret 有效" };
    if (data.errcode === 40164) {
      return { platform, configured: true, valid: false, detail: "当前公网 IP 不在白名单，请到公众平台更新 IP 白名单" };
    }
    return { platform, configured: true, valid: false, detail: `凭证无效：${data.errmsg ?? data.errcode}` };
  } catch (err) {
    return { platform, configured: true, valid: null, detail: `检测失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function verifyBilibili(): Promise<PlatformHealth> {
  const platform = "bilibili";
  const sess = getCredential("bilibili", "access_token");
  const csrf = getCredential("bilibili", "csrf");
  if (!sess || !csrf) return { platform, configured: false, valid: null, detail: "未配置 SESSDATA/bili_jct" };
  try {
    const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { Cookie: `SESSDATA=${sess}`, "User-Agent": UA },
    });
    const data = (await res.json()) as { code: number; data?: { isLogin?: boolean; uname?: string } };
    if (data.code === 0 && data.data?.isLogin) {
      return { platform, configured: true, valid: true, detail: `已登录：${data.data.uname}` };
    }
    return { platform, configured: true, valid: false, detail: "SESSDATA 已失效，请重新粘贴 Cookie" };
  } catch (err) {
    return { platform, configured: true, valid: null, detail: `检测失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function verifyKuaishou(): Promise<PlatformHealth> {
  const platform = "kuaishou";
  const appId = getCredential("kuaishou", "app_id");
  const appSecret = getCredential("kuaishou", "app_secret");
  if (!appId || !appSecret) return { platform, configured: false, valid: null, detail: "未配置 app_id/app_secret" };
  try {
    const res = await fetch("https://open.kuaishou.com/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret, grant_type: "client_credentials" }),
    });
    const data = (await res.json()) as { access_token?: string; description?: string };
    if (data.access_token) return { platform, configured: true, valid: true, detail: "app_id/app_secret 有效" };
    return { platform, configured: true, valid: false, detail: `凭证无效：${data.description ?? "未知错误"}` };
  } catch (err) {
    return { platform, configured: true, valid: null, detail: `检测失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; result: Record<string, PlatformHealth> } | null = null;

/** 实测全部平台登录态。force=true 跳过缓存（发布预检用）。 */
export async function verifyAllPlatforms(force = false): Promise<Record<string, PlatformHealth>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;

  const result: Record<string, PlatformHealth> = {};
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const b = browser;
    const checks = await Promise.all([
      ...Object.keys(RPA_CHECKS).map((p) => verifyRpa(p, b)),
      verifyChannels(),
      verifyWechat(),
      verifyBilibili(),
      verifyKuaishou(),
    ]);
    for (const h of checks) result[h.platform] = h;
  } finally {
    await browser?.close();
  }
  cache = { at: Date.now(), result };
  return result;
}
