import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../../db/accounts-repo.js";
import { AccountReferencedError } from "../../db/accounts-repo.js";
import type { DbAccount } from "../../db/types.js";

export const accountsRoutes = new Hono();

// GET / — list all accounts
accountsRoutes.get("/", (c) => {
  const accounts = accountsRepo.listAccounts();
  return c.json({ accounts });
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
  return c.json(account, 201);
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
  return c.json(account);
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
