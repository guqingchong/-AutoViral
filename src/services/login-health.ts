import { chromium, type Browser } from "playwright";
import { getCredential } from "../db/platform-credentials-repo.js";

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

const RPA_CHECKS: Record<string, { url: string; loginPattern: RegExp }> = {
  douyin: { url: "https://creator.douyin.com/creator-micro/content/upload", loginPattern: /\/login/ },
  xiaohongshu: { url: "https://creator.xiaohongshu.com/publish/publish", loginPattern: /\/login/ },
  channels: { url: "https://channels.weixin.qq.com/platform/post/create", loginPattern: /login/ },
  zhihu: { url: "https://zhuanlan.zhihu.com/write", loginPattern: /signin|login/ },
};

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
    await context.close();
    if (check.loginPattern.test(finalUrl)) {
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
