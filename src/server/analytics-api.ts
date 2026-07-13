/**
 * Phase 5 Analytics API — publish records, platform metrics, and data collection.
 * Mounted at /api/analytics/v2/ (to coexist with the existing /api/analytics route).
 */

import { Hono } from "hono";
import {
  listPublishRecords,
  getPublishRecord,
  createPublishRecord,
  updatePublishRecord,
} from "../db/publish-records-repo.js";
import {
  getLatestMetricByRecord,
  listMetricsByRecord,
  listLatestWorkMetrics,
  getLatestAccountMetric,
} from "../db/platform-metrics-repo.js";
import { listWorks } from "../db/works-repo.js";
import { listTopics } from "../services/trend-research.js";
import { listTemplates } from "../db/templates-repo.js";
import { analyzeWork, computeBaseline } from "../services/hit-failure-analysis.js";
import { createBaseline, listBaselines } from "../db/baselines-repo.js";
import { collectAllOnce, startScheduler, stopScheduler } from "../services/analytics-scheduler.js";
import { registerAdapter } from "../services/platform-adapters/registry.js";
import { KuaishouAdapter } from "../services/platform-adapters/kuaishou-api.js";
import { BilibiliAdapter } from "../services/platform-adapters/bilibili-api.js";
import { ZhihuAdapter } from "../services/platform-adapters/zhihu-api.js";
import { WechatAdapter } from "../services/platform-adapters/wechat-api.js";

export const analyticsApi = new Hono();

// ── Publish Records ────────────────────────────────────────────────────────

// GET /api/analytics/v2/records
analyticsApi.get("/records", (c) => {
  const platform = c.req.query("platform");
  const status = c.req.query("status");
  const records = listPublishRecords({
    ...(platform ? { platform } : {}),
    ...(status ? { status: status as any } : {}),
  });
  return c.json({ records });
});

// GET /api/analytics/v2/records/:id
analyticsApi.get("/records/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const record = getPublishRecord(id);
  if (!record) return c.json({ error: "Record not found" }, 404);
  return c.json(record);
});

// POST /api/analytics/v2/records
analyticsApi.post("/records", async (c) => {
  const body = await c.req.json<{
    work_id: string;
    platform: string;
    platform_post_id?: string;
    status?: string;
  }>();
  if (!body.work_id || !body.platform) {
    return c.json({ error: "work_id and platform are required" }, 400);
  }
  const record = createPublishRecord({
    work_id: body.work_id,
    platform: body.platform,
    platform_post_id: body.platform_post_id,
    status: (body.status as any) ?? "published",
    metadata: "{}",
  });
  return c.json(record, 201);
});

// GET /api/analytics/v2/metrics/work/:recordId
analyticsApi.get("/metrics/work/:recordId", (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const metrics = listMetricsByRecord(recordId);
  const latest = getLatestMetricByRecord(recordId);
  return c.json({ metrics, latest });
});

// GET /api/analytics/v2/metrics/account/:platform
analyticsApi.get("/metrics/account/:platform", (c) => {
  const platform = c.req.param("platform");
  const metric = getLatestAccountMetric(platform);
  if (!metric) return c.json({ error: "No account metrics found" }, 404);
  return c.json(metric);
});

// GET /api/analytics/v2/metrics/latest
analyticsApi.get("/metrics/latest", (c) => {
  const platform = c.req.query("platform");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const metrics = listLatestWorkMetrics({ platform, limit });
  return c.json({ metrics });
});

// GET /api/analytics/v2/works — list all works with analytics data
analyticsApi.get("/works", (c) => {
  const platform = c.req.query("platform");
  const works = listWorks();
  const filtered = platform ? works.filter((w: any) => w.platforms?.includes(platform)) : works;
  return c.json({ works: filtered });
});

// GET /api/analytics/v2/overview — aggregated counts for dashboard
analyticsApi.get("/overview", (c) => {
  const works = listWorks();
  const topics = listTopics(undefined, 200);
  const templates = listTemplates();
  return c.json({
    totalWorks: works.length,
    totalTopics: topics.length,
    activeTemplates: templates.filter((t: any) => t.status === "published").length,
    draftsCount: works.filter((w: any) => w.status === "draft").length,
    inProgressCount: works.filter((w: any) => !["draft", "published", "failed"].includes(w.status)).length,
    publishedCount: works.filter((w: any) => w.status === "published").length,
    failedCount: works.filter((w: any) => w.status === "failed").length,
  });
});

// GET /api/analytics/v2/baselines — list all computed baselines
analyticsApi.get("/baselines", (c) => {
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const baselines = listBaselines(limit);
  return c.json({ baselines });
});

// ── Hit/Failure Analysis ───────────────────────────────────────────────────

// GET /api/analytics/v2/analysis/:recordId
analyticsApi.get("/analysis/:recordId", (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const analysis = analyzeWork(recordId);
  if (!analysis) return c.json({ error: "Analysis not available" }, 404);
  return c.json(analysis);
});

// POST /api/analytics/v2/baselines/compute
analyticsApi.post("/baselines/compute", async (c) => {
  const body = await c.req.json<{ platform: string }>();
  if (!body.platform) return c.json({ error: "platform required" }, 400);
  const baseline = computeBaseline(body.platform, "work_performance");
  if (!baseline) return c.json({ error: "Insufficient data for baseline" }, 400);
  const saved = createBaseline(baseline);
  return c.json(saved, 201);
});

// ── Collection Control ─────────────────────────────────────────────────────

// POST /api/analytics/v2/collect — trigger one-shot collection
analyticsApi.post("/collect", async (c) => {
  try {
    const result = await collectAllOnce();
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// POST /api/analytics/v2/scheduler/start
analyticsApi.post("/scheduler/start", (c) => {
  startScheduler();
  return c.json({ started: true });
});

// POST /api/analytics/v2/scheduler/stop
analyticsApi.post("/scheduler/stop", (c) => {
  stopScheduler();
  return c.json({ stopped: true });
});

// ── Adapter Registration (one-shot at startup) ─────────────────────────────

/**
 * Register all available platform adapters.
 * Called once at server startup.
 */
export function registerAllAdapters(): void {
  try { registerAdapter(new KuaishouAdapter()); } catch { /* already registered */ }
  try { registerAdapter(new BilibiliAdapter()); } catch { /* already registered */ }
  try { registerAdapter(new ZhihuAdapter()); } catch { /* already registered */ }
  try { registerAdapter(new WechatAdapter()); } catch { /* already registered */ }
  // Playwright-based scrapers require a browser — register only if Playwright is available
  try {
    // Dynamic import so it doesn't break if playwright isn't installed
    import("../services/platform-adapters/douyin-scraper.js").then(({ DouyinScraper }) => {
      try { registerAdapter(new DouyinScraper()); } catch { /* ignore */ }
    }).catch(() => {});
    import("../services/platform-adapters/xiaohongshu-scraper.js").then(({ XiaohongshuScraper }) => {
      try { registerAdapter(new XiaohongshuScraper()); } catch { /* ignore */ }
    }).catch(() => {});
  } catch { /* Playwright not available */ }
}
