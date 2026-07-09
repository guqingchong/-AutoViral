import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import { createRenderJob } from "../../src/db/render-jobs-repo.js";
import type { DbWork } from "../../src/db/types.js";

describe("template endpoints", () => {
  let app: Hono;

  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    app = new Hono();
    app.route("/", apiRoutes);
  });

  afterEach(() => closeDb());

  function sampleTemplate() {
    return {
      id: "tpl_test",
      name: "测试模板",
      contentForm: "knowledge",
      canvas: { width: 1080, height: 1920, fps: 30 },
      variables: [{ name: "title", type: "text", label: "标题" }],
      layers: [{ id: "l1", type: "text", content: "{{title}}", start: 0, duration: 1, position: "center" }],
      audio: [],
      status: "draft",
    };
  }

  it("POST /api/templates creates a template", async () => {
    const res = await app.request("/api/templates", {
      method: "POST",
      body: JSON.stringify(sampleTemplate()),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("tpl_test");
  });

  it("GET /api/templates lists templates", async () => {
    await app.request("/api/templates", { method: "POST", body: JSON.stringify(sampleTemplate()), headers: { "Content-Type": "application/json" } });
    const res = await app.request("/api/templates?status=draft");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.templates.length).toBe(1);
  });

  it("POST /api/works/:id/render requires templateId", async () => {
    const work: DbWork = {
      id: "w_render", title: "Render Test", type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    createWork(work, []);
    const res = await app.request("/api/works/w_render/render", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/templates/:id returns 200 for existing template", async () => {
    await app.request("/api/templates", { method: "POST", body: JSON.stringify(sampleTemplate()), headers: { "Content-Type": "application/json" } });
    const res = await app.request("/api/templates/tpl_test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("tpl_test");
    expect(data.name).toBe("测试模板");
  });

  it("GET /api/templates/:id returns 404 for missing template", async () => {
    const res = await app.request("/api/templates/nonexistent");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Template not found");
  });

  it("PUT /api/templates/:id updates and returns 200", async () => {
    await app.request("/api/templates", { method: "POST", body: JSON.stringify(sampleTemplate()), headers: { "Content-Type": "application/json" } });
    const res = await app.request("/api/templates/tpl_test", {
      method: "PUT",
      body: JSON.stringify({ ...sampleTemplate(), name: "updated name" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("updated name");
  });

  it("PUT /api/templates/:id returns 404 for non-existent template", async () => {
    const res = await app.request("/api/templates/nonexistent", {
      method: "PUT",
      body: JSON.stringify({ name: "new name" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("PUT /api/templates/:id returns 400 for invalid data", async () => {
    await app.request("/api/templates", { method: "POST", body: JSON.stringify(sampleTemplate()), headers: { "Content-Type": "application/json" } });
    const res = await app.request("/api/templates/tpl_test", {
      method: "PUT",
      body: JSON.stringify({ name: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/templates/:id deletes and returns 200", async () => {
    await app.request("/api/templates", { method: "POST", body: JSON.stringify(sampleTemplate()), headers: { "Content-Type": "application/json" } });
    const res = await app.request("/api/templates/tpl_test", { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
  });

  it("DELETE /api/templates/:id returns 404 for non-existent template", async () => {
    const res = await app.request("/api/templates/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /api/render-jobs returns empty list when no jobs exist", async () => {
    const res = await app.request("/api/render-jobs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs).toEqual([]);
  });

  it("GET /api/render-jobs returns created jobs", async () => {
    const work: DbWork = {
      id: "w_rj", title: "Render Job", type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    createWork(work, []);
    createRenderJob({ id: "rj_test", work_id: "w_rj", status: "pending", progress: 0 });
    const res = await app.request("/api/render-jobs");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs.length).toBe(1);
    expect(data.jobs[0].id).toBe("rj_test");
  });
});
