/**
 * AutoViral E2E 测试 — 端到端用户旅程
 *
 * 模拟用户从创建作品到发布的完整流程。
 * 使用 Hono app.request() 进行 HTTP 级别测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { analyticsApi } from "../../src/server/analytics-api.js";
import { analyticsRoutes } from "../../src/server/routes/analytics.js";
import { commentsRoutes } from "../../src/server/routes/comments.js";
import { evolutionRoutes } from "../../src/server/routes/evolution.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

function makeApp() {
  const app = new Hono();
  app.route("/api/analytics/v2", analyticsApi);
  app.route("/api/analytics", analyticsRoutes);
  app.route("/api/comments", commentsRoutes);
  app.route("/api/evolution", evolutionRoutes);
  app.route("/", apiRoutes);
  return app;
}

let app: Hono;
let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "av-e2e-"));
  process.env.AUTOVIRAL_DATA_DIR = testDir;

  // Create minimal data directory structure
  await mkdir(join(testDir, "works"), { recursive: true });
  await mkdir(join(testDir, "skills"), { recursive: true });
  await writeFile(join(testDir, "config.yaml"), "interests: []\nplatforms: []\n", "utf-8");

  resetInMemoryDb();
  migrate();
  app = makeApp();
});

afterAll(async () => {
  process.env.AUTOVIRAL_DATA_DIR = ORIGINAL_ENV;
  try { closeDb(); } catch { /* already closed */ }
  try { await rm(testDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

// ── Journey 1: Work Lifecycle ─────────────────────────────────────────────

describe("E2E Journey 1: 作品全生命周期", () => {
  let workId: string;

  it("Step 1: 创建作品 → 201", async () => {
    const res = await app.request("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "E2E 测试作品",
        type: "image-text" as string,
        platforms: ["douyin"],
        topicHint: "AI 绘画工具测评",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBeTruthy();
    expect(body.title).toBe("E2E 测试作品");
    expect(body.topicHint).toBe("AI 绘画工具测评");
    workId = body.id as string;
  });

  it("Step 2: 获取作品详情 → 200", async () => {
    const res = await app.request(`/api/works/${workId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(workId);
    expect(body.status).toBe("draft");
    // Verify pipeline steps exist
    expect(body.pipeline).toBeTruthy();
    const pipeline = body.pipeline as Record<string, unknown>;
    expect(Object.keys(pipeline).length).toBeGreaterThanOrEqual(2);
  });

  it("Step 3: 更新作品 → 200", async () => {
    const res = await app.request(`/api/works/${workId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "E2E 更新后标题" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.title).toBe("E2E 更新后标题");
  });

  it("Step 4: 列出作品 → 包含新作品", async () => {
    const res = await app.request("/api/works");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const works = body.works as Array<Record<string, unknown>>;
    expect(works.some(w => w.id === workId)).toBe(true);
  });

  it("Step 5: 作品列表过滤 → 按状态过滤", async () => {
    const res = await app.request("/api/works?status=draft");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const works = body.works as Array<Record<string, unknown>>;
    const draftWorks = works.filter(w => w.status === "draft");
    expect(draftWorks.length).toBeGreaterThanOrEqual(1);
  });

  it("Step 6: 删除作品 → 200", async () => {
    const res = await app.request(`/api/works/${workId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("Step 7: 确认已删除 → 404", async () => {
    const res = await app.request(`/api/works/${workId}`);
    expect(res.status).toBe(404);
  });
});

// ── Journey 2: Analytics Dashboard ────────────────────────────────────────

describe("E2E Journey 2: 数据分析看板", () => {
  it("健康检查 → 200 + 结构正确", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("配置读取 → 200", async () => {
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.interests).toBeDefined();
  });

  it("Analytics 总览 → 200", async () => {
    const res = await app.request("/api/analytics/v2/overview");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.totalWorks).toBeDefined();
    expect(body.totalTopics).toBeDefined();
    expect(body.activeTemplates).toBeDefined();
  });

  it("Analytics records → 200", async () => {
    const res = await app.request("/api/analytics/v2/records");
    expect(res.status).toBe(200);
  });

  it("Analytics metrics/latest → 200", async () => {
    const res = await app.request("/api/analytics/v2/metrics/latest");
    expect(res.status).toBe(200);
  });

  it("Analytics baselines → 200", async () => {
    const res = await app.request("/api/analytics/v2/baselines");
    expect(res.status).toBe(200);
  });

  it("Comments 列表 → 200", async () => {
    const res = await app.request("/api/comments");
    expect(res.status).toBe(200);
  });

  it("Evolution rules → 200", async () => {
    const res = await app.request("/api/evolution/rules");
    expect(res.status).toBe(200);
  });

  it("Logs → 200 或 503", async () => {
    const res = await app.request("/api/logs");
    expect([200, 503]).toContain(res.status);
  });
});

// ── Journey 3: Topics & Content Pipeline ──────────────────────────────────

describe("E2E Journey 3: 选题与内容流水线", () => {
  it("话题列表 → 200", async () => {
    const res = await app.request("/api/topics");
    expect(res.status).toBe(200);
  });

  it("话题趋势报告 → 200 或 404 (无数据)", async () => {
    const res = await app.request("/api/trends/douyin/report");
    expect([200, 404]).toContain(res.status);
  });

  it("生成提供商列表 → 200 + 数组", async () => {
    const res = await app.request("/api/generate/providers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── Journey 4: Error Handling ─────────────────────────────────────────────

describe("E2E Journey 4: 错误处理与边界条件", () => {
  it("不存在的作品 → 404 + JSON 错误体", async () => {
    const res = await app.request("/api/works/nonexistent-id-12345");
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBeTruthy();
  });

  it("空 body 创建作品 → 处理优雅", async () => {
    const res = await app.request("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // Should not crash; may return 201 (with defaults) or 400
    expect([201, 400]).toContain(res.status);
  });

  it("无效 JSON body → 4xx 而非 500", async () => {
    const res = await app.request("/api/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    expect(res.status).toBeLessThan(500);
  });

  it("缺失必填字段 → 400", async () => {
    const res = await app.request("/api/analytics/v2/baselines/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("不存在的 Analytics 记录 → 404", async () => {
    const res = await app.request("/api/analytics/v2/records/99999");
    expect(res.status).toBe(404);
  });

  it("不存在的平台 metrics → 404", async () => {
    const res = await app.request("/api/analytics/v2/metrics/account/__nonexistent__");
    expect(res.status).toBe(404);
  });
});

// ── Journey 5: Multiple Work CRUD ─────────────────────────────────────────

describe("E2E Journey 5: 批量作品操作", () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    // Clean up created works
    for (const id of createdIds) {
      await app.request(`/api/works/${id}`, { method: "DELETE" });
    }
  });

  it("批量创建 3 个作品并验证全部可获取", async () => {
    const titles = ["测试A", "测试B", "测试C"];
    for (const title of titles) {
      const res = await app.request("/api/works", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          type: "image-text",
          platforms: ["douyin"],
          topicHint: `${title} 方向`,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      createdIds.push(body.id as string);
    }

    // Verify all 3 exist
    const listRes = await app.request("/api/works");
    const listBody = await listRes.json() as Record<string, unknown>;
    const works = listBody.works as Array<Record<string, unknown>>;
    for (const id of createdIds) {
      expect(works.some(w => w.id === id)).toBe(true);
    }
  });
});
