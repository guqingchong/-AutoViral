import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

describe("admin endpoints", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-admin-"));
    process.env.AUTOVIRAL_DATA_DIR = testDir;
    resetInMemoryDb();
    migrate();
    app = new Hono();
    app.route("/", apiRoutes);
  });

  afterEach(async () => {
    closeDb();
    process.env.AUTOVIRAL_DATA_DIR = ORIGINAL_ENV;
    await rm(testDir, { recursive: true, force: true });
  });

  it("POST /api/admin/backup creates a zip", async () => {
    const zipPath = join(testDir, "out.zip");
    const res = await app.request("/api/admin/backup", {
      method: "POST",
      body: JSON.stringify({ path: zipPath }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.path).toBe(zipPath);
  });

  it("POST /api/admin/backup with no path generates default path", async () => {
    const res = await app.request("/api/admin/backup", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.path).toContain("autoviral-backup-");
  });

  it("POST /api/admin/restore fails on missing path", async () => {
    const res = await app.request("/api/admin/restore", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Missing backup path");
  });

  it("POST /api/admin/restore fails on non-existent file", async () => {
    const res = await app.request("/api/admin/restore", {
      method: "POST",
      body: JSON.stringify({ path: "/nonexistent/backup.zip" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("Backup file not found");
  });

  it("POST /api/admin/restore recovers from a valid backup zip", async () => {
    // First create a backup
    const zipPath = join(testDir, "backup.zip");
    await app.request("/api/admin/backup", {
      method: "POST",
      body: JSON.stringify({ path: zipPath }),
      headers: { "Content-Type": "application/json" },
    });
    // Then restore it
    const res = await app.request("/api/admin/restore", {
      method: "POST",
      body: JSON.stringify({ path: zipPath, overwrite: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.restored)).toBe(true);
  });

  it("POST /api/admin/migrate dry-run returns metadata", async () => {
    const res = await app.request("/api/admin/migrate?dryRun=true", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dryRun).toBe(true);
    expect(data.wouldMigrate).toBe(true);
  });

  it("POST /api/admin/migrate runs real migration", async () => {
    const res = await app.request("/api/admin/migrate", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.migrated).toBe("number");
  });
});
