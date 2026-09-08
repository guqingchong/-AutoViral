import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P6 配套(2026-09-08 复审 C-1):v2 出生 draft 不得被 reconcile 派生对齐提拔——
// v2 首步出生即 active,旧实现对账 1 分钟内把 draft 提成 researching,
// 看门狗误拉起链完整复原(P6 形同虚设)。
describe("reconcile × P6 draft(C-1)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-reconcile-draft-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  it("v2 作品出生 draft,对账不提拔", async () => {
    const { createWork, getWork } = await import("../../src/work-store.js");
    const { reconcileWorkStates } = await import("../../src/services/reconcile.js");

    const work = await createWork({ title: "手动创建", type: "short-video", platforms: ["douyin"] } as never);
    expect(work.status).toBe("draft"); // P6 出生态

    await reconcileWorkStates("periodic");
    const after = await getWork(work.id);
    expect(after!.status).toBe("draft"); // 对账后仍是 draft(旧实现会提成 researching)
  });

  it("非 draft 中间态的向前对齐不受影响", async () => {
    const { createWork, getWork, updateWork } = await import("../../src/work-store.js");
    const { reconcileWorkStates } = await import("../../src/services/reconcile.js");

    const work = await createWork({ title: "对齐测试", type: "short-video", platforms: ["douyin"] } as never);
    // 人为把 status 写成 researching(模拟已启动),首步 active 派生也是 researching,不回归
    await updateWork(work.id, { status: "researching" });
    await reconcileWorkStates("periodic");
    expect((await getWork(work.id))!.status).toBe("researching");
  });
});
