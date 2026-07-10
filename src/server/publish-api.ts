import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../db/publish-accounts-repo.js";
import * as jobsRepo from "../db/publish-jobs-repo.js";
import * as bannedWordsRepo from "../db/banned-words-repo.js";
import { createPublishJobs, retryPublishJob } from "../services/publish-service.js";
import { listSupportedPlatforms } from "../services/publish-factory.js";

export const publishRoutes = new Hono();

const SUPPORTED_PLATFORMS = listSupportedPlatforms();
const VALID_ACCOUNT_STATUSES = ["active", "disabled", "expired"] as const;

publishRoutes.get("/accounts", async (c) => {
  const accounts = accountsRepo.listAccounts();
  return c.json({ accounts });
});

publishRoutes.post("/accounts", async (c) => {
  const body = await c.req.json<{
    platform: string;
    displayName: string;
    credentials?: Record<string, unknown>;
  }>();
  if (!SUPPORTED_PLATFORMS.includes(body.platform)) {
    return c.json({ error: `Unsupported platform: ${body.platform}` }, 400);
  }
  const account = accountsRepo.createAccount({
    id: randomUUID(),
    platform: body.platform,
    display_name: body.displayName,
    credentials: body.credentials ?? {},
    status: "active",
    is_default: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return c.json({ account }, 201);
});

publishRoutes.put("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Partial<{
    displayName: string;
    credentials: Record<string, unknown>;
    status: string;
    isDefault: boolean;
  }>>();
  const updates: Partial<Parameters<typeof accountsRepo.updateAccount>[1]> = {};
  if (body.displayName !== undefined) updates.display_name = body.displayName;
  if (body.credentials !== undefined) updates.credentials = body.credentials;
  if (body.status !== undefined) {
    if (!VALID_ACCOUNT_STATUSES.includes(body.status as typeof VALID_ACCOUNT_STATUSES[number])) {
      return c.json({ error: `Invalid status: must be one of ${VALID_ACCOUNT_STATUSES.join(", ")}` }, 400);
    }
    updates.status = body.status as "active" | "disabled" | "expired";
  }
  if (body.isDefault !== undefined) updates.is_default = body.isDefault;
  const account = accountsRepo.updateAccount(id, updates);
  if (!account) return c.json({ error: "Account not found" }, 404);
  return c.json({ account });
});

publishRoutes.delete("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const ok = accountsRepo.deleteAccount(id);
    if (!ok) return c.json({ error: "Account not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/constraint failed|FOREIGN KEY/i.test(message)) {
      return c.json({ error: "Cannot delete account with existing publish jobs" }, 400);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

publishRoutes.get("/jobs", async (c) => {
  const status = c.req.query("status");
  const workId = c.req.query("workId");
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 20;
  const rawOffset = Number(c.req.query("offset"));
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const jobs = jobsRepo.listJobs({ status, workId, limit, offset });
  return c.json({ jobs });
});

publishRoutes.post("/jobs", async (c) => {
  const body = await c.req.json<{
    workId: string;
    renderJobId?: string;
    accountIds: string[];
    title: string;
    content: string;
    mediaPath?: string;
    forcePublish?: boolean;
  }>();
  if (typeof body.workId !== "string" || !body.workId) {
    return c.json({ error: "workId is required" }, 400);
  }
  if (typeof body.title !== "string" || !body.title) {
    return c.json({ error: "title is required" }, 400);
  }
  if (typeof body.content !== "string" || !body.content) {
    return c.json({ error: "content is required" }, 400);
  }
  if (!Array.isArray(body.accountIds)) {
    return c.json({ error: "accountIds must be an array" }, 400);
  }
  const result = createPublishJobs(body);
  if (result.blocked) {
    return c.json({ error: result.error ?? "Compliance check failed", compliance: result.compliance }, 400);
  }
  return c.json({ jobs: result.jobs }, 201);
});

publishRoutes.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = jobsRepo.getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json({ job });
});

publishRoutes.post("/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  try {
    retryPublishJob(id);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Return 404 for "not found" errors, 400 for other validation errors
    if (/not found/i.test(message)) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 400);
  }
});

publishRoutes.get("/banned-words", async (c) => {
  const platform = c.req.query("platform");
  const words = bannedWordsRepo.listBannedWords(platform ?? undefined);
  return c.json({ words });
});

publishRoutes.post("/banned-words", async (c) => {
  const body = await c.req.json<{ platform: string; word: string; severity: "low" | "medium" | "high" }>();
  const word = bannedWordsRepo.createBannedWord({
    platform: body.platform,
    word: body.word,
    severity: body.severity,
  });
  return c.json({ word }, 201);
});
