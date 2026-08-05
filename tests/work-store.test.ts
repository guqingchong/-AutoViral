import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";

// dataDir 在 config.ts 模块加载时定型，必须在任何 src import 之前指向临时目录
vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMP ?? "/tmp";
  process.env.AUTOVIRAL_DATA_DIR = `${base}/av-i6-${process.pid}-${Date.now()}`;
});

// 隔离 legacy 迁移（避免读取真实 dataDir 的 YAML 污染内存库）
vi.mock("../src/db/migrate-legacy.js", () => ({
  migrateLegacyWorks: vi.fn(async () => 0),
}));

import { resetInMemoryDb, closeDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createWork } from "../src/db/works-repo.js";
import { listWorks } from "../src/work-store.js";
import type { DbWork, DbPipelineStep } from "../src/db/types.js";

function makeWork(id: string, updatedAt: string): DbWork {
  return {
    id,
    title: `作品 ${id}`,
    type: "short-video",
    status: "assetting",
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("I6: work-store lastActivityAt 归一化为 ISO 8601（带 Z）", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterAll(async () => {
    closeDb();
    await rm(process.env.AUTOVIRAL_DATA_DIR!, { recursive: true, force: true }).catch(() => {});
  });

  it("步骤时间为 datetime('now') 空格格式时，lastActivityAt 仍输出 ISO 带 Z", async () => {
    // 作品 updated_at 是 ISO；某步骤 completed_at 是 SQLite datetime('now') 空格格式且更晚
    const steps: DbPipelineStep[] = [
      {
        work_id: "w1",
        step_key: "research",
        name: "话题调研",
        status: "done",
        started_at: "2026-08-05 09:00:00",
        completed_at: "2026-08-05 10:00:00",
        sort_order: 0,
      },
    ];
    createWork(makeWork("w1", "2026-08-05T08:00:00.000Z"), steps);

    const [summary] = await listWorks();
    // 取最新（空格格式的 10:00）并归一化：Safari 可解析、Chrome 无时区偏差
    expect(summary.lastActivityAt).toBe("2026-08-05T10:00:00.000Z");
    expect(summary.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("全 ISO 输入时行为不变", async () => {
    const steps: DbPipelineStep[] = [
      {
        work_id: "w2",
        step_key: "research",
        name: "话题调研",
        status: "done",
        started_at: "2026-08-05T09:00:00.000Z",
        completed_at: "2026-08-05T10:00:00.000Z",
        sort_order: 0,
      },
    ];
    createWork(makeWork("w2", "2026-08-05T08:00:00.000Z"), steps);

    const [summary] = await listWorks();
    expect(summary.lastActivityAt).toBe("2026-08-05T10:00:00.000Z");
  });

  it("无任何步骤时间时回落到作品 updated_at（ISO）", async () => {
    createWork(makeWork("w3", "2026-08-05T08:00:00.000Z"), []);
    const [summary] = await listWorks();
    expect(summary.lastActivityAt).toBe("2026-08-05T08:00:00.000Z");
  });
});
