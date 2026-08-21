import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../../db/accounts-repo.js";
import { AccountReferencedError } from "../../db/accounts-repo.js";
import { getCredential, getCredentialsByPlatform } from "../../db/platform-credentials-repo.js";
import { setAccountCredential } from "../../db/account-credentials-repo.js";
import { normalizePlatformKey } from "../../services/credential-resolver.js";
import { triggerLogin } from "../../services/publishing.js";
import { verifyAllAccounts } from "../../services/login-health.js";
import type { DbAccount } from "../../db/types.js";

export const accountsRoutes = new Hono();

/** RPA 平台（Playwright 网页自动化）：session_cookie 直接驱动浏览器登录态 */
const RPA_PLATFORMS = new Set(["douyin", "xiaohongshu", "channels", "zhihu"]);

/**
 * 账号凭证入库：凭证落 account_credentials（账号维度，2026-08-20 数据看板重构）。
 * 此前桥接到 platform_credentials 旧表，同平台第二个账号会顶掉第一个的 cookie；
 * 旧表不再由本路由写入（保留作 deprecated 兜底，见 credential-resolver）。
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
function storeAccountCredentials(accountId: string, platform: string, username?: string | null, cookie?: string | null): string[] {
  const stored: string[] = [];
  const cookieVal = (cookie ?? "").trim();
  const userVal = (username ?? "").trim();

  if (RPA_PLATFORMS.has(platform)) {
    if (cookieVal) {
      setAccountCredential(accountId, "session_cookie", cookieVal);
      stored.push(`${platform}/session_cookie`);
      // 知乎兼容：若填的不是 cookie JSON 而是 OAuth access_token，同步给官方 API 发布器
      if (platform === "zhihu" && !cookieVal.startsWith("[")) {
        setAccountCredential(accountId, "access_token", cookieVal);
        stored.push("zhihu/access_token");
      }
    }
    return stored;
  }

  if (platform === "wechat_mp") {
    if (userVal) { setAccountCredential(accountId, "app_id", userVal); stored.push("wechat/app_id"); }
    if (cookieVal) { setAccountCredential(accountId, "app_secret", cookieVal); stored.push("wechat/app_secret"); }
    return stored;
  }

  if (platform === "kuaishou") {
    if (userVal) { setAccountCredential(accountId, "app_id", userVal); stored.push("kuaishou/app_id"); }
    if (cookieVal) { setAccountCredential(accountId, "app_secret", cookieVal); stored.push("kuaishou/app_secret"); }
    return stored;
  }

  if (platform === "bilibili") {
    if (cookieVal) {
      const sess = cookieVal.match(/SESSDATA=([^;]+)/)?.[1];
      const csrf = cookieVal.match(/bili_jct=([^;]+)/)?.[1];
      if (sess) { setAccountCredential(accountId, "access_token", sess); stored.push("bilibili/access_token"); }
      if (csrf) { setAccountCredential(accountId, "csrf", csrf); stored.push("bilibili/csrf"); }
      if (!sess) { setAccountCredential(accountId, "access_token", cookieVal); stored.push("bilibili/access_token"); }
    }
    return stored;
  }

  return stored;
}

/**
 * 按账号触发浏览器登录。accountId 透传到发布器:登录直接用该账号的画像目录
 * (browser-profiles/<platform>/<accountId>),与发布同画像,避免指纹分裂。
 * 发布器 login() 内部会把 cookie 写入 account_credentials(账号维度);
 * 下面的旧表桥保留作冗余兜底(登录中途异常时仍可从旧表补齐)。
 */
async function loginForAccount(account: DbAccount): Promise<boolean> {
  const ok = await triggerLogin(account.platform, account.id);
  if (ok) {
    const legacy = getCredential(normalizePlatformKey(account.platform), "session_cookie");
    if (legacy) setAccountCredential(account.id, "session_cookie", legacy);
  }
  return ok;
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

// GET /login-health — 实测各账号登录态是否仍然有效（?force=1 跳过 10 分钟缓存）
// 2026-08-20 Task 3:按账号维度返回(原按平台)。
accountsRoutes.get("/login-health", async (c) => {
  const force = c.req.query("force") === "1";
  try {
    const accounts = await verifyAllAccounts(force);
    return c.json({ accounts });
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
  const stored = storeAccountCredentials(account.id, body.platform, body.username, body.cookie);
  return c.json({ ...account, bridgedCredentials: stored }, 201);
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
  const stored = storeAccountCredentials(account.id, account.platform, account.username, account.cookie);
  return c.json({ ...account, bridgedCredentials: stored });
});

// POST /:id/default — 设为该平台默认账号
accountsRoutes.post("/:id/default", (c) => {
  const account = accountsRepo.getAccount(c.req.param("id"));
  if (!account) return c.json({ error: "Account not found" }, 404);
  accountsRepo.setDefaultAccount(account.platform, account.id);
  return c.json({ success: true });
});

// POST /:id/login — 按账号触发浏览器登录（仅 RPA 平台）
accountsRoutes.post("/:id/login", async (c) => {
  const account = accountsRepo.getAccount(c.req.param("id"));
  if (!account) return c.json({ error: "Account not found" }, 404);
  if (!RPA_PLATFORMS.has(account.platform)) return c.json({ error: "该平台不支持浏览器登录" }, 400);
  try {
    const ok = await loginForAccount(account);
    return c.json({ success: ok });
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /login/:platform — 旧端点保留:转发到该平台默认账号(无账号时退化为原平台级登录)
accountsRoutes.post("/login/:platform", async (c) => {
  const platform = c.req.param("platform");
  if (!RPA_PLATFORMS.has(platform)) {
    return c.json({ error: "该平台不支持浏览器登录（仅抖音/小红书/知乎/视频号支持）" }, 400);
  }
  try {
    const target = accountsRepo.listAccountsByPlatform(platform)
      .find((a) => !a.status || a.status === "active");
    const ok = target ? await loginForAccount(target) : await triggerLogin(platform);
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
