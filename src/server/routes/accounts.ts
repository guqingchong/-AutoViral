import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../../db/accounts-repo.js";
import { AccountReferencedError } from "../../db/accounts-repo.js";
import { setCredential, getCredentialsByPlatform } from "../../db/platform-credentials-repo.js";
import { triggerLogin } from "../../services/publishing.js";
import { verifyAllPlatforms } from "../../services/login-health.js";
import type { DbAccount } from "../../db/types.js";

export const accountsRoutes = new Hono();

/** RPA 平台（Playwright 网页自动化）：session_cookie 直接驱动浏览器登录态 */
const RPA_PLATFORMS = new Set(["douyin", "xiaohongshu", "channels", "zhihu"]);

/**
 * 账号凭证桥接：把 accounts 表中的凭证字段同步到发布器实际读取的
 * platform_credentials 表（此前两张表零同步，填了账号密码发布器看不到）。
 *
 * 字段约定（UI 引导用户按此填写）：
 * - RPA 平台：cookie 字段粘贴浏览器导出的 cookie（JSON 数组或 cookie 字符串均可，
 *   Playwright 发布器期望 JSON 数组）
 * - 公众号(wechat_mp)：username=AppID，cookie 字段=AppSecret
 * - 快手：username=app_id，cookie 字段=app_secret
 * - 知乎：已改为 RPA（官方开放平台关闭个人申请），cookie 字段同抖音/小红书；
 *   若持有有效 OAuth token 也可填 access_token 走官方 API（见下方兼容分支）
 * - B站：cookie 字段粘贴完整 cookie（自动解析 SESSDATA/bili_jct）或仅 SESSDATA
 */
function bridgeAccountCredentials(platform: string, username?: string | null, cookie?: string | null): string[] {
  const bridged: string[] = [];
  const cookieVal = (cookie ?? "").trim();
  const userVal = (username ?? "").trim();

  if (RPA_PLATFORMS.has(platform)) {
    if (cookieVal) {
      setCredential(platform, "session_cookie", cookieVal);
      bridged.push(`${platform}/session_cookie`);
      // 知乎兼容：若填的不是 cookie JSON 而是 OAuth access_token，同步给官方 API 发布器
      if (platform === "zhihu" && !cookieVal.startsWith("[")) {
        setCredential("zhihu", "access_token", cookieVal);
        bridged.push("zhihu/access_token");
      }
    }
    return bridged;
  }

  if (platform === "wechat_mp") {
    if (userVal) { setCredential("wechat", "app_id", userVal); bridged.push("wechat/app_id"); }
    if (cookieVal) { setCredential("wechat", "app_secret", cookieVal); bridged.push("wechat/app_secret"); }
    return bridged;
  }

  if (platform === "kuaishou") {
    if (userVal) { setCredential("kuaishou", "app_id", userVal); bridged.push("kuaishou/app_id"); }
    if (cookieVal) { setCredential("kuaishou", "app_secret", cookieVal); bridged.push("kuaishou/app_secret"); }
    return bridged;
  }

  if (platform === "bilibili") {
    if (cookieVal) {
      const sess = cookieVal.match(/SESSDATA=([^;]+)/)?.[1];
      const csrf = cookieVal.match(/bili_jct=([^;]+)/)?.[1];
      if (sess) { setCredential("bilibili", "access_token", sess); bridged.push("bilibili/access_token"); }
      if (csrf) { setCredential("bilibili", "csrf", csrf); bridged.push("bilibili/csrf"); }
      if (!sess) { setCredential("bilibili", "access_token", cookieVal); bridged.push("bilibili/access_token"); }
    }
    return bridged;
  }

  return bridged;
}

// GET / — list all accounts
accountsRoutes.get("/", (c) => {
  const accounts = accountsRepo.listAccounts();
  return c.json({ accounts });
});

// GET /credential-status — 各平台发布器凭证就绪状态（platform_credentials 聚合）
accountsRoutes.get("/credential-status", (c) => {
  const platforms = ["douyin", "xiaohongshu", "channels", "kuaishou", "bilibili", "zhihu", "wechat"];
  const status: Record<string, { keys: string[]; configured: boolean }> = {};
  for (const p of platforms) {
    const keys = getCredentialsByPlatform(p).map((k) => k.key_type);
    let configured = false;
    if (p === "douyin" || p === "xiaohongshu") configured = keys.includes("session_cookie");
    else if (p === "channels") configured = keys.includes("session_cookie");
    else if (p === "kuaishou" || p === "wechat") configured = keys.includes("app_id") && keys.includes("app_secret");
    else if (p === "zhihu") configured = keys.includes("session_cookie") || keys.includes("access_token");
    else if (p === "bilibili") configured = keys.includes("access_token") && keys.includes("csrf");
    status[p] = { keys, configured };
  }
  return c.json({ status });
});

// GET /login-health — 实测各平台登录态是否仍然有效（?force=1 跳过 10 分钟缓存）
accountsRoutes.get("/login-health", async (c) => {
  const force = c.req.query("force") === "1";
  try {
    const health = await verifyAllPlatforms(force);
    return c.json({ health });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /:id — get one account
accountsRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const account = accountsRepo.getAccount(id);
  if (!account) return c.json({ error: "Account not found" }, 404);
  return c.json(account);
});

const VALID_PLATFORMS = new Set(["douyin", "xiaohongshu", "channels", "kuaishou", "bilibili", "wechat_mp", "zhihu"]);

// POST / — create account
accountsRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name: string; platform: string; tone_profile?: Record<string, unknown>; username?: string; password?: string; cookie?: string }>();
  if (!body.name?.trim() || !body.platform) {
    return c.json({ error: "name and platform are required" }, 400);
  }
  if (body.name.trim().length > 100) {
    return c.json({ error: "name must be 100 characters or less" }, 400);
  }
  if (!VALID_PLATFORMS.has(body.platform)) {
    return c.json({ error: `unsupported platform: ${body.platform}` }, 400);
  }
  const now = new Date().toISOString();
  const account = accountsRepo.createAccount({
    id: randomUUID(),
    name: body.name,
    platform: body.platform,
    tone_profile: body.tone_profile ?? {},
    status: "active",
    username: body.username,
    password: body.password,
    cookie: body.cookie,
    created_at: now,
    updated_at: now,
  });
  const bridged = bridgeAccountCredentials(body.platform, body.username, body.cookie);
  return c.json({ ...account, bridgedCredentials: bridged }, 201);
});

// PUT /:id — update account
accountsRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Partial<DbAccount>>();
  const updates: Partial<DbAccount> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.platform !== undefined) updates.platform = body.platform;
  if (body.tone_profile !== undefined) updates.tone_profile = body.tone_profile;
  if (body.status !== undefined) updates.status = body.status;
  if (body.username !== undefined) updates.username = body.username;
  if (body.password !== undefined) updates.password = body.password;
  if (body.cookie !== undefined) updates.cookie = body.cookie;
  const account = accountsRepo.updateAccount(id, updates);
  if (!account) return c.json({ error: "Account not found" }, 404);
  const platform = account.platform;
  const bridged = bridgeAccountCredentials(platform, account.username, account.cookie);
  return c.json({ ...account, bridgedCredentials: bridged });
});

// POST /login/:platform — 触发浏览器登录（RPA 平台：人工登录一次后 cookie 自动入库）
accountsRoutes.post("/login/:platform", async (c) => {
  const platform = c.req.param("platform");
  if (!["douyin", "xiaohongshu", "zhihu", "channels"].includes(platform)) {
    return c.json({ error: "该平台不支持浏览器登录（仅抖音/小红书/知乎/视频号支持）" }, 400);
  }
  try {
    const ok = await triggerLogin(platform);
    return c.json({ success: ok });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /:id — delete account (rejects if works reference it)
accountsRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  try {
    const deleted = accountsRepo.deleteAccount(id);
    if (!deleted) return c.json({ error: "Account not found" }, 404);
    return c.json({ deleted: true });
  } catch (e) {
    if (e instanceof AccountReferencedError) {
      return c.json({ error: e.message, code: e.code }, 409);
    }
    return c.json({ error: "Failed to delete account" }, 500);
  }
});

export default accountsRoutes;
