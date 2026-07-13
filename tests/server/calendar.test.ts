import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

describe("calendar API", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-calendar-"));
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

  function postEntry(body: Record<string, unknown>) {
    return app.request("/api/calendar", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("GET /api/calendar returns entries in date range", async () => {
    await postEntry({ title: "Monday Post", scheduled_date: "2026-08-10" });
    await postEntry({ title: "Friday Post", scheduled_date: "2026-08-15" });

    const res = await app.request("/api/calendar?from=2026-08-01&to=2026-08-31");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(2);
  });

  it("GET /api/calendar requires from and to params", async () => {
    const res = await app.request("/api/calendar");
    expect(res.status).toBe(400);
  });

  it("GET /api/calendar/month/:yearMonth returns entries and counts", async () => {
    await postEntry({ title: "Post 1", scheduled_date: "2026-08-01" });
    await postEntry({ title: "Post 2", scheduled_date: "2026-08-01" });
    await postEntry({ title: "Post 3", scheduled_date: "2026-08-15" });

    const res = await app.request("/api/calendar/month/2026-08");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toHaveLength(3);
    expect(data.counts["01"]).toBe(2);
    expect(data.counts["15"]).toBe(1);
  });

  it("GET /api/calendar/month validates format", async () => {
    const res = await app.request("/api/calendar/month/2026-8");
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar creates an entry", async () => {
    const res = await postEntry({ title: "New Post", scheduled_date: "2026-08-20" });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.title).toBe("New Post");
    expect(data.scheduled_date).toBe("2026-08-20");
    expect(data.status).toBe("planned");
    expect(data.id).toBeTruthy();
  });

  it("POST /api/calendar creates entry with all optional fields", async () => {
    const res = await postEntry({
      title: "Full Entry",
      scheduled_date: "2026-08-25",
      scheduled_time: "14:30",
      platform: "douyin",
      content_type: "short-video",
      color: "#FE2C55",
      description: "A test entry",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.scheduled_time).toBe("14:30");
    expect(data.platform).toBe("douyin");
    expect(data.color).toBe("#FE2C55");
    expect(data.description).toBe("A test entry");
  });

  it("POST /api/calendar rejects missing title", async () => {
    const res = await postEntry({ scheduled_date: "2026-08-20" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects missing scheduled_date", async () => {
    const res = await postEntry({ title: "No Date" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects title > 100 chars", async () => {
    const res = await postEntry({ title: "x".repeat(150), scheduled_date: "2026-08-20" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects invalid platform", async () => {
    const res = await postEntry({ title: "Test", scheduled_date: "2026-08-20", platform: "twitter" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects invalid content_type", async () => {
    const res = await postEntry({ title: "Test", scheduled_date: "2026-08-20", content_type: "long-form" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects invalid status", async () => {
    const res = await postEntry({ title: "Test", scheduled_date: "2026-08-20", status: "archived" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects invalid scheduled_date format", async () => {
    const res = await postEntry({ title: "Test", scheduled_date: "2026/08/20" });
    expect(res.status).toBe(400);
  });

  it("POST /api/calendar rejects invalid scheduled_time format", async () => {
    const res = await postEntry({ title: "Test", scheduled_date: "2026-08-20", scheduled_time: "2:30 PM" });
    expect(res.status).toBe(400);
  });

  it("PUT /api/calendar/:id rejects empty title", async () => {
    const createRes = await postEntry({ title: "Test", scheduled_date: "2026-08-20" });
    const created = await createRes.json();
    const res = await app.request(`/api/calendar/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "   " }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("PUT /api/calendar/:id rejects invalid status", async () => {
    const createRes = await postEntry({ title: "Test", scheduled_date: "2026-08-20" });
    const created = await createRes.json();
    const res = await app.request(`/api/calendar/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "deleted" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/calendar/:id returns entry", async () => {
    const createRes = await postEntry({ title: "Test Entry", scheduled_date: "2026-08-20" });
    const created = await createRes.json();

    const res = await app.request(`/api/calendar/${created.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe("Test Entry");
  });

  it("GET /api/calendar/:id returns 404", async () => {
    const res = await app.request("/api/calendar/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PUT /api/calendar/:id updates entry", async () => {
    const createRes = await postEntry({ title: "Old Title", scheduled_date: "2026-08-20" });
    const created = await createRes.json();

    const res = await app.request(`/api/calendar/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "New Title", status: "done" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe("New Title");
    expect(data.status).toBe("done");
    expect(data.scheduled_date).toBe("2026-08-20"); // unchanged
  });

  it("PUT /api/calendar/:id returns 404 for nonexistent", async () => {
    const res = await app.request("/api/calendar/nonexistent", {
      method: "PUT",
      body: JSON.stringify({ title: "Nope" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/calendar/:id deletes entry", async () => {
    const createRes = await postEntry({ title: "ToDelete", scheduled_date: "2026-08-20" });
    const created = await createRes.json();

    const res = await app.request(`/api/calendar/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);

    // verify gone
    const getRes = await app.request(`/api/calendar/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("DELETE /api/calendar/:id returns 404 for nonexistent", async () => {
    const res = await app.request("/api/calendar/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
