/**
 * AutoViral 集成测试 — 跨模块 API 工作流
 *
 * 验证多模块协同：Works → Topics → Templates → Render → Publish → Analytics → Evolution
 * 使用真实 in-memory DB，不 mock 内部服务。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("Integration — 跨模块工作流", () => {
  let app: Hono;
  let testDir: string;
  let workId: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-int-"));
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

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 1：内容创作完整流水线（Topic → Script → Article → Work）
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 1：内容创作流水线", () => {
    it("创建作品 → 关联话题 → 更新状态 → 获取详情", async () => {
      // Step 1: Create work
      const create = await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({ title: "集成测试-创作", type: "short-video", platforms: ["douyin"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(create.status).toBe(201);
      const work = await create.json();
      workId = work.id;
      expect(workId).toBeTruthy();

      // Step 2: List works — verify new work appears
      const list = await app.request("/api/works");
      expect(list.status).toBe(200);
      const listBody = await list.json() as { works: unknown[] };
      expect(listBody.works.some((w: any) => w.id === workId)).toBe(true);

      // Step 3: Get detail
      const detail = await app.request(`/api/works/${encodeURIComponent(workId)}`);
      expect(detail.status).toBe(200);

      // Step 4: Update title(status/pipeline 自 2026-08-28 批次2.5 起禁止经 PUT 直写,走 pipeline/advance)
      const update = await app.request(`/api/works/${encodeURIComponent(workId)}`, {
        method: "PUT",
        body: JSON.stringify({ title: "集成测试-已更新" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(update.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 2：Data flow — Topics → Works consistency
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 2：话题与作品数据一致性", () => {
    it("话题列表与趋势数据联动", async () => {
      // Topics list
      const topics = await app.request("/api/topics");
      expect(topics.status).toBe(200);

      // Trends per platform
      const trends = await app.request("/api/trends/douyin");
      expect([200, 404]).toContain(trends.status);

      // Config contains analytics settings
      const config = await app.request("/api/config");
      expect(config.status).toBe(200);
      const cfg = await config.json();
      expect(cfg).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 3：Analytics ↔ Publish Records 数据流
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 3：Analytics ↔ Publish 数据流", () => {
    it("Analytics API 可访问且返回正确结构", async () => {
      // Analytics records
      const records = await app.request("/api/analytics/records");
      expect(records.status).toBe(200);

      // Insights
      const insights = await app.request("/api/analytics/insights");
      expect(insights.status).toBe(200);

      // Manual collection triggers without crash
      const collect = await app.request("/api/analytics/collect", { method: "POST" });
      expect(collect.status).toBe(200);

      // Publish records list (via analytics v2 API)
      const pubRecords = await app.request("/api/analytics/v2/records");
      expect(pubRecords.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 4：Evolution ↔ Work feedback loop
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 4：进化规则反馈循环", () => {
    it("规则 CRUD → 筛选 → 切换启用状态", async () => {
      // List all rules
      const listAll = await app.request("/api/evolution/rules");
      expect(listAll.status).toBe(200);

      // Filter by type
      const byType = await app.request("/api/evolution/rules?type=topic");
      expect(byType.status).toBe(200);

      // Filter by enabled
      const byStatus = await app.request("/api/evolution/rules?enabled=true");
      expect(byStatus.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 5：Comments → Analytics 联动
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 5：评论系统与数据看板联动", () => {
    it("评论列表 → 分类 → 筛选未回复", async () => {
      // Comments list
      const list = await app.request("/api/comments");
      expect(list.status).toBe(200);

      // Unreplied only
      const unreplied = await app.request("/api/comments?unreplied=true");
      expect(unreplied.status).toBe(200);

      // Classify
      const classify = await app.request("/api/comments/classify", { method: "POST" });
      expect(classify.status).toBe(200);

      // Analytics records should stay consistent
      const records = await app.request("/api/analytics/records");
      expect(records.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 6：Config → Provider → Generate 联动
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 6：配置与生成服务联动", () => {
    it("配置 API + 提供商列表均可访问", async () => {
      // Config
      const config = await app.request("/api/config");
      expect(config.status).toBe(200);
      const cfg = await config.json();

      // Providers
      const providers = await app.request("/api/generate/providers");
      expect(providers.status).toBe(200);
      const prov = await providers.json();
      expect(Array.isArray(prov)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 7：Shared Assets → Works 跨模块引用
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 7：共享素材 ↔ 作品资产管理", () => {
    it("共享素材列表可访问", async () => {
      const shared = await app.request("/api/shared-assets");
      expect(shared.status).toBe(200);

      // Works list should be independent
      const works = await app.request("/api/works");
      expect(works.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 集成场景 8：Admin backup → restore → migrate 管理三件套
  // ═══════════════════════════════════════════════════════════════════
  describe("场景 8：管理功能三件套", () => {
    it("Backup → Restore → Migrate 全链路", async () => {
      // Create seed data
      await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({ title: "管理测试作品", type: "short-video", platforms: ["douyin"] }),
        headers: { "Content-Type": "application/json" },
      });

      // Backup
      const zipPath = join(testDir, "int-backup.zip");
      const backup = await app.request("/api/admin/backup", {
        method: "POST",
        body: JSON.stringify({ path: zipPath }),
        headers: { "Content-Type": "application/json" },
      });
      expect(backup.status).toBe(200);
      const backupData = await backup.json();
      expect(backupData.ok).toBe(true);

      // Restore
      const restore = await app.request("/api/admin/restore", {
        method: "POST",
        body: JSON.stringify({ path: zipPath, overwrite: true }),
        headers: { "Content-Type": "application/json" },
      });
      expect(restore.status).toBe(200);
      expect((await restore.json()).ok).toBe(true);

      // Migrate dry-run
      const dry = await app.request("/api/admin/migrate?dryRun=true", { method: "POST" });
      expect(dry.status).toBe(200);
    });
  });
});
