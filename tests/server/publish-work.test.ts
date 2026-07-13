import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { publishWorkRoutes } from "../../src/server/routes/publish.js";

/* ── Mock external dependencies ── */
vi.mock("../../src/services/publishing.js", () => ({
  publishToPlatform: vi.fn(),
  getPublishingStatus: vi.fn(),
  triggerLogin: vi.fn(),
  buildPublishInput: vi.fn(),
}));

vi.mock("../../src/db/works-repo.js", () => ({
  getWork: vi.fn(),
}));

vi.mock("../../src/db/publish-records-repo.js", () => ({
  listPublishRecords: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { publishToPlatform, getPublishingStatus, triggerLogin, buildPublishInput } from "../../src/services/publishing.js";
import { getWork } from "../../src/db/works-repo.js";
import { listPublishRecords } from "../../src/db/publish-records-repo.js";
import { readFile } from "node:fs/promises";

function createTestApp() {
  const app = new Hono();
  app.route("/api/works/:id/publish", publishWorkRoutes);
  return app;
}

const WORK_ID = "w_publish_test";

describe("publishWorkRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ── POST /:platform ── */
  describe("POST /:platform", () => {
    it("returns 404 when work does not exist", async () => {
      vi.mocked(getWork).mockResolvedValue(undefined as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "测试标题" }),
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Work not found");
    });

    it("publishes with explicit body fields when title is provided", async () => {
      vi.mocked(getWork).mockResolvedValue({ id: WORK_ID, title: "old" } as any);
      const record = {
        id: 1,
        workId: WORK_ID,
        platform: "douyin",
        status: "published",
        platformPostId: "p123",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(publishToPlatform).mockResolvedValue(record as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "My Title",
          videoPath: "/v.mp4",
          coverPath: "/c.jpg",
          options: { tags: ["a"] },
        }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("published");
      expect(vi.mocked(publishToPlatform)).toHaveBeenCalledWith(
        WORK_ID,
        "douyin",
        expect.objectContaining({
          workId: WORK_ID,
          videoPath: "/v.mp4",
          coverPath: "/c.jpg",
          title: "My Title",
          options: { tags: ["a"] },
        })
      );
    });

    it("builds PublishInput from work when body is empty", async () => {
      const work = { id: WORK_ID, title: "Auto Title" };
      vi.mocked(getWork).mockResolvedValue(work as any);
      const builtInput = {
        workId: WORK_ID,
        videoPath: "/data/works/w_publish_test/output/final.mp4",
        coverPath: "/data/works/w_publish_test/output/cover.jpg",
        title: "Auto Title",
        options: {},
      };
      vi.mocked(buildPublishInput).mockResolvedValue(builtInput);
      const record = {
        id: 2,
        workId: WORK_ID,
        platform: "douyin",
        status: "published",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(publishToPlatform).mockResolvedValue(record as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(buildPublishInput)).toHaveBeenCalledWith(work, "douyin");
      expect(vi.mocked(publishToPlatform)).toHaveBeenCalledWith(
        WORK_ID,
        "douyin",
        builtInput
      );
    });

    it("publishes with body that has no title — uses buildPublishInput fallback", async () => {
      const work = { id: WORK_ID, title: "Fallback Title" };
      vi.mocked(getWork).mockResolvedValue(work as any);
      const builtInput = {
        workId: WORK_ID,
        videoPath: "/f.mp4",
        title: "Fallback Title",
        options: {},
      };
      vi.mocked(buildPublishInput).mockResolvedValue(builtInput);
      vi.mocked(publishToPlatform).mockResolvedValue({ id: 3, status: "published" } as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/xiaohongshu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ options: { schedule: true } }),
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(buildPublishInput)).toHaveBeenCalled();
    });
  });

  /* ── POST /:platform/login ── */
  describe("POST /:platform/login", () => {
    it("triggers login for douyin", async () => {
      vi.mocked(triggerLogin).mockResolvedValue(true);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin/login`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(vi.mocked(triggerLogin)).toHaveBeenCalledWith("douyin");
    });

    it("triggers login for xiaohongshu", async () => {
      vi.mocked(triggerLogin).mockResolvedValue(false);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/xiaohongshu/login`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it("rejects login for unsupported platform (channels)", async () => {
      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/channels/login`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("不支持浏览器登录");
    });
  });

  /* ── GET /records ── */
  describe("GET /records", () => {
    it("returns publish records for the work", async () => {
      vi.mocked(getPublishingStatus).mockResolvedValue([
        { id: 1, workId: WORK_ID, platform: "douyin", status: "published" },
        { id: 2, workId: WORK_ID, platform: "xiaohongshu", status: "failed" },
      ] as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/records`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.publishRecords).toHaveLength(2);
      expect(json.publishRecords[0].platform).toBe("douyin");
      expect(json.publishRecords[1].status).toBe("failed");
    });

    it("returns empty array when no records exist", async () => {
      vi.mocked(getPublishingStatus).mockResolvedValue([]);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/records`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.publishRecords).toEqual([]);
    });
  });

  /* ── GET /status ── */
  describe("GET /status", () => {
    it("returns publish status (same as records)", async () => {
      vi.mocked(getPublishingStatus).mockResolvedValue([
        { id: 1, workId: WORK_ID, platform: "xiaohongshu", status: "scheduled" },
      ] as any);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/status`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.publishRecords).toHaveLength(1);
    });
  });

  /* ── GET /:platform/fallback ── */
  describe("GET /:platform/fallback", () => {
    it("returns 404 when no fallback record exists", async () => {
      vi.mocked(listPublishRecords).mockReturnValue([]);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin/fallback`);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain("No fallback package");
    });

    it("returns 404 when record exists but no fallback status", async () => {
      vi.mocked(listPublishRecords).mockReturnValue([
        { platform: "xiaohongshu", status: "failed", metadata: null } as any,
      ]);

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/xiaohongshu/fallback`);
      expect(res.status).toBe(404);
    });

    it("serves fallback zip when record has fallback status", async () => {
      const zipPath = "/tmp/fallback/test.zip";
      vi.mocked(listPublishRecords).mockReturnValue([
        {
          platform: "douyin",
          status: "fallback",
          metadata: JSON.stringify({ fallbackPackagePath: zipPath }),
        } as any,
      ]);
      vi.mocked(readFile).mockResolvedValue(Buffer.from("fake-zip-data"));

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/douyin/fallback`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/zip");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      const body = await res.arrayBuffer();
      expect(body.byteLength).toBeGreaterThan(0);
    });

    it("returns 404 when fallback file is missing on disk", async () => {
      vi.mocked(listPublishRecords).mockReturnValue([
        {
          platform: "xiaohongshu",
          status: "fallback",
          metadata: JSON.stringify({ fallbackPackagePath: "/missing.zip" }),
        } as any,
      ]);
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const app = createTestApp();
      const res = await app.request(`/api/works/${WORK_ID}/publish/xiaohongshu/fallback`);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain("Fallback package not found");
    });
  });
});
