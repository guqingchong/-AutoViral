import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import type { DbWork } from "../../src/db/types.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

describe("accounts API", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-accounts-"));
    process.env.AUTOVIRAL_DATA_DIR = testDir;
    resetInMemoryDb();
    migrate();
    app = makeApp();
  });

  afterEach(async () => {
    closeDb();
    process.env.AUTOVIRAL_DATA_DIR = ORIGINAL_ENV;
    await rm(testDir, { recursive: true, force: true });
  });

  it("GET /api/accounts returns empty list", async () => {
    const res = await app.request("/api/accounts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toEqual([]);
  });

  it("POST /api/accounts creates an account", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "抖音主号", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("抖音主号");
    expect(data.platform).toBe("douyin");
    expect(data.status).toBe("active");
    expect(data.id).toBeTruthy();
  });

  it("POST /api/accounts creates account with tone_profile", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "风格账号", platform: "xiaohongshu", tone_profile: { voice: "casual" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.tone_profile).toEqual({ voice: "casual" });
  });

  it("POST /api/accounts rejects missing name", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/accounts rejects whitespace-only name", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "   ", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/accounts rejects name longer than 100 characters", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "a".repeat(101), platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/accounts rejects unsupported platform", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Test", platform: "weibo" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/accounts rejects missing platform", async () => {
    const res = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "No Platform" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/accounts/:id returns account", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Test", platform: "xiaohongshu" }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    const getRes = await app.request(`/api/accounts/${created.id}`);
    expect(getRes.status).toBe(200);
    const data = await getRes.json();
    expect(data.name).toBe("Test");
  });

  it("GET /api/accounts/:id returns 404 for missing", async () => {
    const res = await app.request("/api/accounts/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PUT /api/accounts/:id updates account", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Old", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    const updateRes = await app.request(`/api/accounts/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "New", status: "inactive" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(updateRes.status).toBe(200);
    const data = await updateRes.json();
    expect(data.name).toBe("New");
    expect(data.status).toBe("inactive");
  });

  it("PUT /api/accounts/:id updates tone_profile", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "ToneTest", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    const newTone = { voice: "professional", keywords: ["trendy", "viral"] };
    const updateRes = await app.request(`/api/accounts/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ tone_profile: newTone }),
      headers: { "Content-Type": "application/json" },
    });
    expect(updateRes.status).toBe(200);
    const data = await updateRes.json();
    expect(data.tone_profile).toEqual(newTone);
    // name should be unchanged
    expect(data.name).toBe("ToneTest");
  });

  it("PUT /api/accounts/:id returns 404 for nonexistent", async () => {
    const res = await app.request("/api/accounts/nonexistent", {
      method: "PUT",
      body: JSON.stringify({ name: "Nope" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/accounts/:id deletes account", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "ToDelete", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    const created = await createRes.json();
    const deleteRes = await app.request(`/api/accounts/${created.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const data = await deleteRes.json();
    expect(data.deleted).toBe(true);
  });

  it("DELETE /api/accounts/:id rejects if works reference it", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "Ref", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    const account = await createRes.json();
    const now = new Date().toISOString();
    createWork({
      id: "w_ref", title: "Ref Work", type: "short-video",
      status: "draft", platforms: ["douyin"], evaluation_mode: false,
      account_id: account.id,
      tags: [],
      created_at: now, updated_at: now,
    }, []);
    const deleteRes = await app.request(`/api/accounts/${account.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(409);
    const errorBody = await deleteRes.json();
    expect(errorBody.code).toBe("ACCOUNT_REFERENCED");
    expect(errorBody.error).toContain("still reference it");
  });

  it("DELETE /api/accounts/:id returns 404 for nonexistent", async () => {
    const res = await app.request("/api/accounts/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /api/accounts lists multiple accounts", async () => {
    await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "A", platform: "douyin" }),
      headers: { "Content-Type": "application/json" },
    });
    await app.request("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: "B", platform: "xiaohongshu" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await app.request("/api/accounts");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accounts).toHaveLength(2);
  });
});
