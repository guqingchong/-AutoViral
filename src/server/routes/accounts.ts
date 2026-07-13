import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../../db/accounts-repo.js";

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

// POST / — create account
accountsRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name: string; platform: string; tone_profile?: Record<string, unknown> }>();
  if (!body.name || !body.platform) {
    return c.json({ error: "name and platform are required" }, 400);
  }
  const now = new Date().toISOString();
  const account = accountsRepo.createAccount({
    id: randomUUID(),
    name: body.name,
    platform: body.platform,
    tone_profile: body.tone_profile ?? {},
    status: "active",
    created_at: now,
    updated_at: now,
  });
  return c.json(account, 201);
});

// PUT /:id — update account
accountsRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; platform?: string; tone_profile?: Record<string, unknown>; status?: string }>();
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.platform !== undefined) updates.platform = body.platform;
  if (body.tone_profile !== undefined) updates.tone_profile = body.tone_profile;
  if (body.status !== undefined) updates.status = body.status;
  const account = accountsRepo.updateAccount(id, updates as any);
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
  } catch (e: any) {
    if (e.message?.includes("still reference it")) {
      return c.json({ error: e.message }, 409);
    }
    return c.json({ error: "Failed to delete account" }, 500);
  }
});

export default accountsRoutes;
