import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";

// dataDir 在 config.ts 模块加载时定型，必须在任何 src import 之前指向临时目录，
// 否则 batch-convert 的 work-store.createWork 会往真实 ~/.autoviral 写目录。
vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMP ?? "/tmp";
  process.env.AUTOVIRAL_DATA_DIR = `${base}/av-task5-${process.pid}-${Date.now()}`;
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
import { createTopic } from "../../src/db/topics-repo.js";
import * as queueRepo from "../../src/db/work-queue-repo.js";
import * as avatarsRepo from "../../src/db/avatars-repo.js";
import * as dhJobsRepo from "../../src/db/digital-human-jobs-repo.js";
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

describe("Task5 接线：reject / batch-convert 入队", () => {
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

  it("reject 一个 reviewing 作品：流水线重置 + 入队且位置在 running 之后", async () => {
    // 一个 running 作品 + 一个普通 queued 作品，验证 afterRunning 插在二者之间
    createWork(makeWork("w_run", "assetting"), []);
    createWork(makeWork("w_other", "planning"), []);
    queueRepo.enqueue("w_run");
    queueRepo.setStatus("w_run", "running");
    queueRepo.enqueue("w_other");

    createWork(makeWork("w_rej", "reviewing"), doneSteps("w_rej"));

    const res = await app.request("/api/works/w_rej/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "plan", comment: "分镜重写，太啰嗦" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.delivery).toBe("queued");
    expect(data.status).toBe("planning");

    // 流水线重置语义不变：plan active，其后 pending，之前 done
    expect(data.pipeline.plan.status).toBe("active");
    expect(data.pipeline.research.status).toBe("done");
    expect(data.pipeline.assets.status).toBe("pending");
    expect(data.pipeline.assembly.status).toBe("pending");

    // 审核意见入库
    expect(dbGetWork("w_rej")?.review_comment).toBe("分镜重写，太啰嗦");

    // 已入队，且位置在 running 之后、原 queued 之前
    const item = queueRepo.getItem("w_rej");
    expect(item).toBeDefined();
    expect(item?.status).toBe("queued");
    const order = queueRepo.listQueue().map((i) => i.workId);
    expect(order).toEqual(["w_run", "w_rej", "w_other"]);
  });

  it("batch-convert 两个选题：作品入队等待 runner，不直接起会话", async () => {
    const t1 = createTopic({ title: "选题一", status: "new", tags: [], content_angles: [] } as any);
    const t2 = createTopic({ title: "选题二", status: "new", tags: [], content_angles: [] } as any);

    const res = await app.request("/api/topics/batch-convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicIds: [t1.id, t2.id], type: "short-video" }),
    });
    expect(res.status).toBe(200);
    const { jobId } = await res.json();

    // 轮询任务直至后台串行处理完成
    let job: any;
    for (let i = 0; i < 50; i++) {
      const sres = await app.request(`/api/topics/batch-status/${jobId}`);
      job = await sres.json();
      if (job.status === "done") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.status).toBe("done");
    expect(job.items).toHaveLength(2);

    for (const item of job.items) {
      // 建作品 + 文案完成，stage 停留在 queued（等待 runner 调度）；
      // 若仍走旧的 startWorkSession 直启路径，wsBridge 未初始化会让 item 落到 error
      expect(item.error).toBeUndefined();
      expect(item.workId).toBeDefined();
      expect(item.stage).toBe("queued");

      // 作品已创建且进入作品队列
      expect(dbGetWork(item.workId)).toBeDefined();
      const qItem = queueRepo.getItem(item.workId);
      expect(qItem).toBeDefined();
      expect(qItem?.status).toBe("queued");
    }

    // 两个作品按顺序入队
    const order = queueRepo.listQueue().map((i) => i.workId);
    expect(order).toEqual([job.items[0].workId, job.items[1].workId]);
  });

  it("I2: reject 取消该作品未提交的渲染任务（防重做后复用旧口播/重复计费）", async () => {
    const now = new Date().toISOString();
    avatarsRepo.createAvatar({
      id: "av1", name: "Avatar", status: "ready", source: "heygem",
      reference_video_path: "C:/fake/media.mp4", config: {},
      created_at: now, updated_at: now,
    });
    createWork(makeWork("w_dh", "reviewing"), doneSteps("w_dh"));
    // 渲染池里有一个该作品的 queued 任务（等待攒批）
    dhJobsRepo.createJob({
      id: "dhjob_rej1", work_id: "w_dh", avatar_id: "av1",
      audio_path: "C:/fake/narration.mp3", provider: "heygem",
      status: "queued", progress: 0, estimated_cost: 0.01, actual_cost: 0,
      queue_position: 1, created_at: now, updated_at: now,
    });

    const res = await app.request("/api/works/w_dh/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "assets", comment: "口播重写" }),
    });
    expect(res.status).toBe(200);

    // 旧渲染任务已取消（Task 6 语义：failed + 取消文案），不会被攒批提交
    const job = dhJobsRepo.getJob("dhjob_rej1")!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("取消");

    // 作品正常入队等待重做
    expect(queueRepo.getItem("w_dh")?.status).toBe("queued");
  });
});
