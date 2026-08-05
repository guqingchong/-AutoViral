import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";

// dataDir 在 config.ts 模块加载时定型，必须在任何 src import 之前指向临时目录，
// 否则 batch-convert 的 work-store.createWork 会往真实 ~/.autoviral 写目录。
vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMP ?? "/tmp";
  process.env.AUTOVIRAL_DATA_DIR = `${base}/av-batch-assets-${process.pid}-${Date.now()}`;
});

// 隔离 legacy 迁移（避免读取真实 dataDir 的 YAML 污染内存库）
vi.mock("../../src/db/migrate-legacy.js", () => ({
  migrateLegacyWorks: vi.fn(async () => 0),
}));

// 隔离 LLM 文案生成（真实实现会 spawn claude 进程）
vi.mock("../../src/services/content-generator.js", () => ({
  generateArticleFromTopic: vi.fn(async (topic: { title: string }, platform: string) => ({
    title: topic.title,
    content: "测试正文",
    platform,
  })),
  generateScriptFromArticle: vi.fn(async () => ({ duration: 180, scenes: [] })),
}));

import { Hono } from "hono";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { getWork as dbGetWork } from "../../src/db/works-repo.js";
import { createTopic } from "../../src/db/topics-repo.js";
import { _resetRunner } from "../../src/services/work-queue.js";
import { _resetWatchdog } from "../../src/services/work-watchdog.js";

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

async function runBatch(app: Hono, topicIds: number[], extra: Record<string, unknown>) {
  const res = await app.request("/api/topics/batch-convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicIds, ...extra }),
  });
  expect(res.status).toBe(200);
  const { jobId } = await res.json();
  let job: any;
  for (let i = 0; i < 50; i++) {
    const sres = await app.request(`/api/topics/batch-status/${jobId}`);
    job = await sres.json();
    if (job.status === "done") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(job.status).toBe("done");
  return job;
}

describe("batch-convert 素材三维与双产物", () => {
  let app: Hono;

  beforeEach(() => {
    _resetRunner();
    _resetWatchdog();
    resetInMemoryDb();
    migrate();
    app = makeApp();
  });

  afterAll(async () => {
    closeDb();
    await rm(process.env.AUTOVIRAL_DATA_DIR!, { recursive: true, force: true }).catch(() => {});
  });

  it("video+image-text：作品 type 为 short-video 且 dual_output=1，素材三维入库", async () => {
    const t = createTopic({ title: "双产物选题", status: "new", tags: [], content_angles: [] } as any);

    const job = await runBatch(app, [t.id], {
      type: "video+image-text",
      assetForm: "video-mix",
      assetSource: "stock",
      assetBudget: "eco",
      duration: 300,
    });

    expect(job.items).toHaveLength(1);
    const item = job.items[0];
    expect(item.error).toBeUndefined();
    expect(item.workId).toBeDefined();

    const work = dbGetWork(item.workId)!;
    expect(work.type).toBe("short-video");
    expect(work.dual_output).toBe(true);
    expect(work.asset_form).toBe("video-mix");
    expect(work.asset_source).toBe("stock");
    expect(work.asset_budget).toBe("eco");
    // 素材约束段注入 topicHint（随 startWorkSession prompt 直达 agent）
    expect(work.topic_hint).toContain("素材约束");
    expect(work.topic_hint).toContain("以真实视频混剪为主");
    expect(work.topic_hint).toContain("仅用素材库真实素材");
    expect(work.topic_hint).toContain("禁止 AI 生成视频");
    expect(work.topic_hint).toContain("双产物");
  });

  it("short-video 不带素材三维：dual_output=0，素材列为空", async () => {
    const t = createTopic({ title: "普通短视频选题", status: "new", tags: [], content_angles: [] } as any);

    const job = await runBatch(app, [t.id], { type: "short-video" });

    const work = dbGetWork(job.items[0].workId)!;
    expect(work.type).toBe("short-video");
    expect(work.dual_output).toBe(false);
    expect(work.asset_form).toBeUndefined();
    expect(work.asset_source).toBeUndefined();
    expect(work.asset_budget).toBeUndefined();
  });

  it("image-text：素材三维被忽略，dual_output=0", async () => {
    const t = createTopic({ title: "图文选题", status: "new", tags: [], content_angles: [] } as any);

    const job = await runBatch(app, [t.id], {
      type: "image-text",
      assetForm: "slides",
      assetSource: "ai",
      assetBudget: "premium",
    });

    const work = dbGetWork(job.items[0].workId)!;
    expect(work.type).toBe("image-text");
    expect(work.dual_output).toBe(false);
    expect(work.asset_form).toBeUndefined();
    expect(work.asset_source).toBeUndefined();
    expect(work.asset_budget).toBeUndefined();
  });

  it("非法素材三维值被静默丢弃，不入库", async () => {
    const t = createTopic({ title: "非法参数选题", status: "new", tags: [], content_angles: [] } as any);

    const job = await runBatch(app, [t.id], {
      type: "short-video",
      assetForm: "hologram",
      assetSource: "darkweb",
      assetBudget: "unlimited",
    });

    const work = dbGetWork(job.items[0].workId)!;
    expect(work.asset_form).toBeUndefined();
    expect(work.asset_source).toBeUndefined();
    expect(work.asset_budget).toBeUndefined();
  });
});
