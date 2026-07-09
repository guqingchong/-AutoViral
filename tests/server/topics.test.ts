import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock content-generator so the convert route doesn't spawn real processes
vi.mock("../../src/services/content-generator.js", () => ({
  generateArticleFromTopic: vi.fn(() =>
    Promise.resolve({
      title: "Generated Article Title",
      content: "Generated article content body.\n\nSecond paragraph.",
      platform: "douyin",
    }),
  ),
  generateScriptFromArticle: vi.fn(() =>
    Promise.resolve({
      scenes: [{ timestamp: "0:00-0:15", narration: "Opening", visual: "Host talking" }],
      duration: 180,
    }),
  ),
}));

import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createSnapshot } from "../../src/db/trends-repo.js";
import { createTopic, listTopics } from "../../src/db/topics-repo.js";
import { generateArticleFromTopic } from "../../src/services/content-generator.js";

describe("Topic API routes", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.clearAllMocks();
  });

  afterEach(() => closeDb());

  // ---------------------------------------------------------------------------
  // GET /api/topics
  // ---------------------------------------------------------------------------

  describe("GET /api/topics", () => {
    it("returns empty list when no topics exist", async () => {
      const res = await apiRoutes.request("/api/topics");
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.topics).toEqual([]);
    });

    it("returns topics filtered by platform", async () => {
      const snap = createSnapshot({ platform: "douyin", snapshot_date: "2026-07-09", raw_data: {} });
      createTopic({ platform: "douyin", title: "T1", heat: 5, tags: [], content_angles: [], status: "collected", snapshot_id: snap.id });
      createTopic({ platform: "xiaohongshu", title: "T2", heat: 3, tags: [], content_angles: [], status: "collected", snapshot_id: snap.id });

      const res = await apiRoutes.request("/api/topics?platform=douyin");
      const body = await res.json() as any;
      expect(body.topics).toHaveLength(1);
      expect(body.topics[0].title).toBe("T1");

      // The non-filtered list returns both
      const resAll = await apiRoutes.request("/api/topics");
      const bodyAll = await resAll.json() as any;
      expect(bodyAll.topics).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      const snap = createSnapshot({ platform: "douyin", snapshot_date: "2026-07-09", raw_data: {} });
      for (let i = 0; i < 5; i++) {
        createTopic({ platform: "douyin", title: `T${i}`, heat: 5, tags: [], content_angles: [], status: "collected", snapshot_id: snap.id });
      }

      const res = await apiRoutes.request("/api/topics?limit=2");
      const body = await res.json() as any;
      expect(body.topics).toHaveLength(2);
    });

    it("falls back to default limit when NaN limit is provided", async () => {
      const snap = createSnapshot({ platform: "douyin", snapshot_date: "2026-07-09", raw_data: {} });
      for (let i = 0; i < 60; i++) {
        createTopic({ platform: "douyin", title: `T${i}`, heat: 5, tags: [], content_angles: [], status: "collected", snapshot_id: snap.id });
      }

      const res = await apiRoutes.request("/api/topics?limit=abc");
      const body = await res.json() as any;
      // NaN -> || 50 -> min(50, 200) = 50
      expect(body.topics).toHaveLength(50);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/topics/:id
  // ---------------------------------------------------------------------------

  describe("GET /api/topics/:id", () => {
    it("returns topic by id", async () => {
      const snap = createSnapshot({ platform: "douyin", snapshot_date: "2026-07-09", raw_data: {} });
      const topic = createTopic({
        platform: "douyin", title: "My Topic", heat: 4,
        tags: ["tag1"], content_angles: ["angle1"],
        status: "collected", snapshot_id: snap.id,
      });

      const res = await apiRoutes.request(`/api/topics/${topic.id}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.title).toBe("My Topic");
      expect(body.heat).toBe(4);
    });

    it("returns 404 for non-existent id", async () => {
      const res = await apiRoutes.request("/api/topics/9999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id (NaN)", async () => {
      const res = await apiRoutes.request("/api/topics/abc");
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/topics/:id/convert
  // ---------------------------------------------------------------------------

  describe("POST /api/topics/:id/convert", () => {
    it("converts a topic to a work (article + script)", async () => {
      const snap = createSnapshot({ platform: "douyin", snapshot_date: "2026-07-09", raw_data: {} });
      const topic = createTopic({
        platform: "douyin",
        title: "Convertible Topic",
        heat: 5,
        tags: ["ai", "绘画"],
        content_angles: ["入门", "进阶"],
        emotion_type: "焦虑",
        emotion_subtype: "被替代焦虑",
        description: "AI 绘画趋势",
        status: "collected",
        snapshot_id: snap.id,
      });

      const res = await apiRoutes.request(`/api/topics/${topic.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: ["douyin"], type: "short-video" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.workId).toBeDefined();
      expect(typeof body.workId).toBe("string");
      expect(body.workId).toMatch(/^w_/);

      // Verify topic was updated in DB
      const topics = listTopics("douyin");
      expect(topics[0].status).toBe("converted");
      expect(topics[0].work_id).toBe(body.workId);

      // Verify content-generator was called with the right topic
      expect(vi.mocked(generateArticleFromTopic)).toHaveBeenCalledTimes(1);
    });

    it("returns 400 for invalid topic id", async () => {
      const res = await apiRoutes.request("/api/topics/abc/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent topic", async () => {
      const res = await apiRoutes.request("/api/topics/9999/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });
});
