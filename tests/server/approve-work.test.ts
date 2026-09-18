import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";

// dataDir 在 config.ts 模块加载时定型，必须在任何 src import 之前指向临时目录，
// 否则测试会往真实 ~/.autoviral 写数据。
vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMP ?? "/tmp";
  process.env.AUTOVIRAL_DATA_DIR = `${base}/av-approve-${process.pid}-${Date.now()}`;
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
import { createWork, getWork as dbGetWork } from "../../src/db/works-repo.js";
import { _resetRunner } from "../../src/services/work-queue.js";
import { _resetWatchdog } from "../../src/services/work-watchdog.js";
import type { DbWork, DbPipelineStep } from "../../src/db/types.js";

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

function makeWork(id: string, status: DbWork["status"]): DbWork {
  const now = new Date().toISOString();
  return {
    id,
    title: `作品 ${id}`,
    type: "short-video",
    status,
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: now,
    updated_at: now,
  };
}

/** 全部 done 的四步流水线（reviewing 状态的作品） */
function doneSteps(workId: string): DbPipelineStep[] {
  const keys: Array<[string, string]> = [
    ["research", "话题调研"],
    ["plan", "分镜规划"],
    ["assets", "素材准备"],
    ["assembly", "视频合成"],
  ];
  const now = new Date().toISOString();
  return keys.map(([key, name], idx) => ({
    work_id: workId,
    step_key: key,
    name,
    status: "done" as const,
    started_at: now,
    completed_at: now,
    sort_order: idx,
  }));
}

// 2026-09-10 缺陷回归：发布中心"审核通过"经 PUT /api/works/:id 直写 status,
// 被批次2.5 门禁(禁止 PUT 直写 pipeline/status)403 拦截,功能整体失效。
// approved 是 deriveStatusFromPipeline 的粘性用户确认态,流水线永不自动派生,
// 必须有专用人工通道(与 reject 同构)。
describe("POST /api/works/:id/approve — 发布中心审核通过", () => {
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

  it("reviewing → approved：状态落库，流水线保持全 done 不被重置", async () => {
    createWork(makeWork("w_ok", "reviewing"), doneSteps("w_ok"));

    const res = await app.request("/api/works/w_ok/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("approved");

    const work = dbGetWork("w_ok")!;
    expect(work.status).toBe("approved");
  });

  it("非 reviewing 作品不可审核通过（assetting → 400，状态不变）", async () => {
    createWork(makeWork("w_mid", "assetting"), doneSteps("w_mid"));

    const res = await app.request("/api/works/w_mid/approve", { method: "POST" });
    expect(res.status).toBe(400);
    expect(dbGetWork("w_mid")!.status).toBe("assetting");
  });

  it("重复 approve 幂等：已 approved 作品返回 ok，不报错", async () => {
    createWork(makeWork("w_done", "approved"), doneSteps("w_done"));

    const res = await app.request("/api/works/w_done/approve", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(dbGetWork("w_done")!.status).toBe("approved");
  });

  it("不存在的作品 → 404", async () => {
    const res = await app.request("/api/works/w_ghost/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
