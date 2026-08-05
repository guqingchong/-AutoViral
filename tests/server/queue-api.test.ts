import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork, getWork as dbGetWork } from "../../src/db/works-repo.js";
import * as queueRepo from "../../src/db/work-queue-repo.js";

const ORIGINAL_ENV = process.env.AUTOVIRAL_DATA_DIR;

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

function seedWork(id: string, title: string) {
  const now = new Date().toISOString();
  createWork({
    id, title, type: "short-video",
    status: "draft", platforms: ["douyin"], evaluation_mode: false,
    tags: [],
    created_at: now, updated_at: now,
  } as any, []);
}

describe("queue API", () => {
  let app: Hono;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "av-queue-"));
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

  it("GET /api/queue returns empty list", async () => {
    const res = await app.request("/api/queue");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toEqual([]);
  });

  it("GET /api/queue enriches items with work title and status", async () => {
    seedWork("w1", "第一个作品");
    seedWork("w2", "第二个作品");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");

    const res = await app.request("/api/queue");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.items[0].workId).toBe("w1");
    expect(data.items[0].title).toBe("第一个作品");
    expect(data.items[0].workStatus).toBe("draft");
    expect(data.items[1].workId).toBe("w2");
  });

  it("GET /api/queue marks items whose work was deleted as missing", async () => {
    queueRepo.enqueue("ghost");
    const res = await app.request("/api/queue");
    const data = await res.json();
    expect(data.items[0].workId).toBe("ghost");
    expect(data.items[0].workStatus).toBe("missing");
  });

  it("POST /api/queue/:workId/prioritize moves item to front of queued", async () => {
    seedWork("w1", "A");
    seedWork("w2", "B");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");

    const res = await app.request("/api/queue/w2/prioritize", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.item.workId).toBe("w2");

    const list = queueRepo.listQueue();
    expect(list[0].workId).toBe("w2");
    expect(list[1].workId).toBe("w1");
  });

  it("POST /api/queue/:workId/prioritize returns 404 for unknown work", async () => {
    const res = await app.request("/api/queue/nope/prioritize", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/queue/:workId/prioritize returns 409 for terminal status", async () => {
    seedWork("w1", "A");
    queueRepo.enqueue("w1");
    queueRepo.setStatus("w1", "failed");
    const res = await app.request("/api/queue/w1/prioritize", { method: "POST" });
    expect(res.status).toBe(409);
    // 状态未被改动
    expect(queueRepo.getItem("w1")?.status).toBe("failed");
  });

  it("POST /api/queue/:workId/prioritize on paused item re-queues it at front", async () => {
    seedWork("w1", "A");
    seedWork("w2", "B");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");
    queueRepo.setStatus("w2", "paused");
    const res = await app.request("/api/queue/w2/prioritize", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    // paused 项 prioritize = 插队到运行中之后并恢复排队
    expect(data.item.status).toBe("queued");
    expect(queueRepo.listQueue()[0].workId).toBe("w2");
  });

  it("POST /api/queue/:workId/pause sets status to paused", async () => {
    seedWork("w1", "A");
    queueRepo.enqueue("w1");
    const res = await app.request("/api/queue/w1/pause", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.item.status).toBe("paused");
    expect(queueRepo.getItem("w1")?.status).toBe("paused");
  });

  it("POST /api/queue/:workId/pause returns 409 for terminal status", async () => {
    seedWork("w1", "A");
    queueRepo.enqueue("w1");
    queueRepo.setStatus("w1", "done");
    const res = await app.request("/api/queue/w1/pause", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("POST /api/queue/:workId/pause returns 404 for unknown work", async () => {
    const res = await app.request("/api/queue/nope/pause", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/queue/:workId/resume sets status back to queued", async () => {
    seedWork("w1", "A");
    queueRepo.enqueue("w1");
    queueRepo.setStatus("w1", "paused");
    const res = await app.request("/api/queue/w1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.item.status).toBe("queued");
  });

  it("POST /api/queue/:workId/resume returns 404 for unknown work", async () => {
    const res = await app.request("/api/queue/nope/resume", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /api/queue/:workId/resume returns 409 for terminal status", async () => {
    seedWork("w1", "A");
    queueRepo.enqueue("w1");
    queueRepo.setStatus("w1", "done");
    const res = await app.request("/api/queue/w1/resume", { method: "POST" });
    expect(res.status).toBe(409);
    // 状态未被改动，runner 不会重跑已完结作品
    expect(queueRepo.getItem("w1")?.status).toBe("done");
  });

  it("POST /api/queue/:workId/remove dequeues but keeps the work", async () => {
    seedWork("w1", "保留我");
    queueRepo.enqueue("w1");
    const res = await app.request("/api/queue/w1/remove", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.removed).toBe(true);
    expect(queueRepo.getItem("w1")).toBeUndefined();
    // 作品保留（转手动制作模式）
    expect(dbGetWork("w1")).toBeDefined();
    expect(dbGetWork("w1")?.title).toBe("保留我");
  });

  it("POST /api/queue/:workId/remove returns 404 for unknown work", async () => {
    const res = await app.request("/api/queue/nope/remove", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/queue/:workId dequeues and deletes the work", async () => {
    seedWork("w1", "删掉我");
    queueRepo.enqueue("w1");
    const res = await app.request("/api/queue/w1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deleted).toBe(true);
    expect(queueRepo.getItem("w1")).toBeUndefined();
    expect(dbGetWork("w1")).toBeUndefined();
  });

  it("DELETE /api/queue/:workId returns 404 for nonexistent work", async () => {
    const res = await app.request("/api/queue/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
