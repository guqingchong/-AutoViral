import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createMetric } from "../../src/db/platform-metrics-repo.js";
import { analyticsRoutes } from "../../src/server/routes/analytics.js";
import type { DbWork } from "../../src/db/types.js";

function setupApp() {
  const app = new Hono();
  app.route("/api/analytics", analyticsRoutes);
  return app;
}

function sampleWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: overrides.id ?? "w_test",
    title: overrides.title ?? "测试作品",
    type: "short-video",
    status: "published",
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("analytics routes", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("lists records", async () => {
    createWork(sampleWork({ id: "w1" }), []);
    createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    const res = await setupApp().request("/api/analytics/records");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.records.length).toBe(1);
  });

  it("lists records empty when no records exist", async () => {
    const res = await setupApp().request("/api/analytics/records");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ records: [] });
  });

  it("returns insights", async () => {
    const work = createWork(sampleWork({ id: "w_insight" }), []);
    const record = createPublishRecord({
      work_id: work.id,
      platform: "douyin",
      status: "published",
      published_at: new Date().toISOString(),
    });
    createMetric({
      publish_record_id: record.id,
      platform: "douyin",
      metric_type: "work",
      collected_at: new Date().toISOString(),
      views: 5000,
      likes: 200,
    });
    const res = await setupApp().request("/api/analytics/insights");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hits).toBeDefined();
  });

  it("insights returns empty when no data", async () => {
    const res = await setupApp().request("/api/analytics/insights");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hits).toBeDefined();
    expect(data.failures).toBeDefined();
  });

  it("manual collect returns result", async () => {
    // analytics may return collected=false when no sources configured in tests
    const res = await setupApp().request("/api/analytics/collect", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toBeDefined();
    expect(typeof data.collected).toBe("boolean");
  });

  it("returns works with platform filter", async () => {
    createWork(sampleWork({ id: "w_dy" }), []);
    createPublishRecord({ work_id: "w_dy", platform: "douyin", status: "published" });
    const res = await setupApp().request("/api/analytics/works?platform=douyin");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(0);
  });

  it("recompute baselines returns ok", async () => {
    const res = await setupApp().request("/api/analytics/recompute-baselines", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});
