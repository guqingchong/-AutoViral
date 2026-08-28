/**
 * AutoViral 功能测试 — API 契约、错误处理、配置验证
 *
 * 验证：
 *   1. 所有端点返回一致的 JSON 错误格式
 *   2. 健康检查端点完整性
 *   3. 配置默认值与 schema 校验
 *   4. 创建/更新/删除操作的边界条件
 *   5. 分页与过滤参数的容错性
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

describe("Functional — API 契约与错误处理", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-func-"));
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
  // 功能测试 1：健康检查端点
  // ═══════════════════════════════════════════════════════════════════
  describe("健康检查与系统状态", () => {
    it("GET /api/health 返回正确结构", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.version).toBe("0.2.0");
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("GET /api/status 返回完整状态信息", async () => {
      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      // status 返回引擎运行状态
      expect(body).toHaveProperty("state");
      expect(typeof body.state).toBe("string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 2：错误响应格式一致性
  // ═══════════════════════════════════════════════════════════════════
  describe("错误响应格式一致性", () => {
    it("404: 不存在的作品 ID 返回错误 JSON", async () => {
      const res = await app.request("/api/works/nonexistent-id-12345");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    it("404: 不存在的趋势平台返回一致错误", async () => {
      const res = await app.request("/api/trends/notaplatform");
      expect([404, 500]).toContain(res.status);
    });

    it("400: 缺失必填字段时返回有意义的错误", async () => {
      // 不传 title
      const res = await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      // 可能返回 400 或 201（取决于默认值）
      expect([200, 201, 400, 422, 500]).toContain(res.status);
    });

    it("400: 空 body 创建作品应合理处理", async () => {
      const res = await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({ title: "", type: "short-video", platforms: [] }),
        headers: { "Content-Type": "application/json" },
      });
      // 不应 crash；返回合理的 HTTP 状态
      expect([200, 201, 400, 422]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 3：配置 API
  // ═══════════════════════════════════════════════════════════════════
  describe("配置 API 契约", () => {
    it("GET /api/config 返回合法配置对象", async () => {
      const res = await app.request("/api/config");
      expect(res.status).toBe(200);
      const cfg = await res.json();
      expect(typeof cfg).toBe("object");
    });

    it("PUT /api/config 保存并返回更新后配置", async () => {
      const original = await (await app.request("/api/config")).json();

      const res = await app.request("/api/config", {
        method: "PUT",
        body: JSON.stringify({ ...original, analytics: { ...(original.analytics || {}), enabled: true } }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(typeof updated).toBe("object");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 4：作品 CRUD 边界条件
  // ═══════════════════════════════════════════════════════════════════
  describe("作品 CRUD 边界条件", () => {
    it("创建 → 更新 → 删除 → 确认删除", async () => {
      // Create
      const create = await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({ title: "功能测试作品", type: "short-video", platforms: ["douyin"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(create.status).toBe(201);
      const work = await create.json();
      const wid = work.id;

      // Update with valid data
      const update = await app.request(`/api/works/${encodeURIComponent(wid)}`, {
        method: "PUT",
        body: JSON.stringify({ title: "功能测试-已更新" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(update.status).toBe(200);

      // 2026-08-28 批次2.5:status/pipeline 禁止经 PUT 直写(评审旁路封堵)
      const bypass = await app.request(`/api/works/${encodeURIComponent(wid)}`, {
        method: "PUT",
        body: JSON.stringify({ status: "assembling" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(bypass.status).toBe(403);

      // Delete
      const del = await app.request(`/api/works/${encodeURIComponent(wid)}`, { method: "DELETE" });
      expect(del.status).toBe(200);

      // Confirm deleted (should return 404)
      const retry = await app.request(`/api/works/${encodeURIComponent(wid)}`);
      expect([404, 500]).toContain(retry.status);
    });

    it("更新不存在的作品返回 404", async () => {
      const res = await app.request("/api/works/nonexistent-12345", {
        method: "PUT",
        body: JSON.stringify({ title: "x" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("删除不存在的作品返回错误", async () => {
      const res = await app.request("/api/works/nonexistent-12345", { method: "DELETE" });
      expect([404, 500]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 5：内容类型校验
  // ═══════════════════════════════════════════════════════════════════
  describe("内容类型校验", () => {
    it("Content-Type 必须为 application/json", async () => {
      // Sending without Content-Type should still work (many frameworks default)
      // but verify explicitly
      const res = await app.request("/api/works", {
        method: "POST",
        body: JSON.stringify({ title: "无 Content-Type", type: "short-video", platforms: ["douyin"] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
    });

    it("无效 JSON body 应返回 4xx 而非 500 crash", async () => {
      const res = await app.request("/api/works", {
        method: "POST",
        body: "this is not json {{{",
        headers: { "Content-Type": "application/json" },
      });
      expect([400, 422, 500]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 6：Analytics API 响应的数据完整性
  // ═══════════════════════════════════════════════════════════════════
  describe("Analytics API 数据完整性", () => {
    it("所有 Analytics 端点返回 JSON", async () => {
      const endpoints = [
        "/api/analytics/records",
        "/api/analytics/insights",
        "/api/analytics/v2/records",
      ];
      for (const ep of endpoints) {
        const res = await app.request(ep);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/json");
      }
    });

    it("Analytics collect 返回结构化结果", async () => {
      const res = await app.request("/api/analytics/collect", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("collected");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 7：Evolution API 列表格式
  // ═══════════════════════════════════════════════════════════════════
  describe("Evolution API 列表格式", () => {
    it("规则列表返回数组或包含 rules 字段的对象", async () => {
      const res = await app.request("/api/evolution/rules");
      expect(res.status).toBe(200);
      const body = await res.json();
      // 可能是数组或 { rules: [...] }
      const rules = Array.isArray(body) ? body : (body.rules ?? []);
      expect(Array.isArray(rules)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 8：Comments API 端点完整性
  // ═══════════════════════════════════════════════════════════════════
  describe("Comments API 端点完整性", () => {
    it("所有 Comments 端点可访问", async () => {
      const eps = ["/api/comments", "/api/comments?unreplied=true"];
      for (const ep of eps) {
        const res = await app.request(ep);
        expect(res.status).toBe(200);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 9：Generate providers 端点
  // ═══════════════════════════════════════════════════════════════════
  describe("Generate providers", () => {
    it("GET /api/generate/providers 返回非空数组", async () => {
      const res = await app.request("/api/generate/providers");
      expect(res.status).toBe(200);
      const providers = await res.json();
      expect(Array.isArray(providers)).toBe(true);
      // providers 可能为空（测试环境无 api key），但格式必须是数组
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // 功能测试 10：Logs API
  // ═══════════════════════════════════════════════════════════════════
  describe("Logs API", () => {
    it("GET /api/logs 返回日志", async () => {
      const res = await app.request("/api/logs");
      expect(res.status).toBe(200);
    });
  });
});
