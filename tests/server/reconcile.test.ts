import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P2-T4:配额防护(A3)——分类/冷却/暂停不记恢复次数/试探回退; reconcile 会话感知回归(A4)

describe("quota-guard + work-queue(A3)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-quota-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
  });
  afterEach(async () => {
    const wq = await import("../../src/services/work-queue.js");
    wq._resetRunner();
    const qg = await import("../../src/services/quota-guard.js");
    qg._resetQuota();
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  it("quota 文本分类:usage limit/quota/余额不足 命中,普通错误不命中", async () => {
    const { isQuotaErrorText } = await import("../../src/services/quota-guard.js");
    expect(isQuotaErrorText("403 usage limit for this billing cycle")).toBe(true);
    expect(isQuotaErrorText("insufficient_quota")).toBe(true);
    expect(isQuotaErrorText("账户余额不足")).toBe(true);
    expect(isQuotaErrorText("HTTP 500 internal error")).toBe(false);
  });

  it("冷却期 running→paused 且不记恢复次数;到窗口单次试探;成功解除", async () => {
    const qg = await import("../../src/services/quota-guard.js");
    const wq = await import("../../src/services/work-queue.js");
    const repo = await import("../../src/db/work-queue-repo.js");
    const { createWork } = await import("../../src/work-store.js");

    const work = await createWork({ title: "配额测试", type: "short-video", platforms: ["douyin"] } as never);
    const startWork = vi.fn(async () => {});
    wq.initWorkQueue({ startWork, isSessionAlive: () => true });

    // 先入队跑起来(非冷却:tick 会启动它)
    wq.enqueueWork(work.id);
    await wq._whenIdle();
    expect(repo.getItem(work.id)?.status).toBe("running");
    const attemptsBefore = repo.getItem(work.id)?.resumeAttempts ?? 0;

    // 配额耗尽 → tick:running 置 paused,不再 startWork,不记恢复次数
    qg.reportQuotaExhausted("test");
    expect(qg.quotaAllowsStart()).toBe(false);
    wq.kickRunner();
    await wq._whenIdle();
    expect(repo.getItem(work.id)?.status).toBe("paused");
    expect(startWork).toHaveBeenCalledTimes(1); // 仅入队那次
    expect(repo.getItem(work.id)?.resumeAttempts).toBe(attemptsBefore);

    // 强行到试探窗口(mock 时间) → tick:恢复 running 并单次试探
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    try {
      wq.kickRunner();
      await wq._whenIdle();
      expect(repo.getItem(work.id)?.status).toBe("running");
      expect(startWork).toHaveBeenCalledTimes(2); // 试探这一次
      expect(repo.getItem(work.id)?.resumeAttempts).toBe(attemptsBefore); // 试探不计恢复
    } finally {
      vi.useRealTimers();
    }

    // 试探再次失败 → 回退翻倍(30→60)
    qg.reportQuotaExhausted("probe");
    expect(qg.quotaState().backoffMin).toBe(60);
    // 任一 LLM 成功 → 解除
    qg.reportQuotaSuccess();
    expect(qg.quotaState().exhausted).toBe(false);
    expect(qg.quotaAllowsStart()).toBe(true);
  });
});

describe("reconcile 会话感知回归(A4)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-reconcile-"));
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

  async function makeAssemblingWorkWithFinal(): Promise<string> {
    const { createWork, updateWork } = await import("../../src/work-store.js");
    const w = await createWork({ title: "对账测试", type: "short-video", platforms: ["douyin"] } as never);
    const pipeline = { ...w.pipeline };
    for (const k of Object.keys(pipeline)) {
      pipeline[k] = { ...pipeline[k], status: k === "assembly" ? "active" : "done" };
    }
    if (pipeline.assembly) pipeline.assembly.startedAt = new Date(Date.now() - 3600_000).toISOString();
    await updateWork(w.id, { pipeline, status: "assembling" } as never);
    // 新鲜 final.mp4(mtime 晚于 assembly startedAt)
    const out = join(dir, "works", w.id, "output");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "final_test.mp4"), "fake");
    return w.id;
  }

  it("活跃会话 + final.mp4 存在 → 不转正(评审门不旁路)", async () => {
    const id = await makeAssemblingWorkWithFinal();
    const rec = await import("../../src/services/reconcile.js");
    rec.initReconcile(() => true); // 会话活跃
    const r = await rec.reconcileWorkStates("periodic");
    const { getWork } = await import("../../src/work-store.js");
    expect((await getWork(id))?.status).toBe("assembling");
    expect(r.details.join()).not.toContain("转正");
  });

  it("无活跃会话 + 新鲜 final.mp4 + 评审关闭 → 转正 reviewing", async () => {
    const id = await makeAssemblingWorkWithFinal();
    // 批次11(2026-08-31):评审开启的作品无 pass verdict 不转正(留待重审)。
    // 本用例覆盖"评审本就没开"的作品——对账转正是为它们准备的恢复通道
    const { updateWork } = await import("../../src/work-store.js");
    await updateWork(id, { evaluationMode: false } as never);
    const rec = await import("../../src/services/reconcile.js");
    rec.initReconcile(() => false);
    await rec.reconcileWorkStates("periodic");
    const { getWork } = await import("../../src/work-store.js");
    expect((await getWork(id))?.status).toBe("reviewing");
  });

  it("评审开启 + 无 verdict(评审自身出错) + 新鲜 final.mp4 → 不转正,留待重审(2026-08-31 a4d 实证)", async () => {
    const id = await makeAssemblingWorkWithFinal();
    // createWork 默认 evaluationMode=true,无任何评审结论文件
    const rec = await import("../../src/services/reconcile.js");
    rec.initReconcile(() => false);
    await rec.reconcileWorkStates("periodic");
    const { getWork } = await import("../../src/work-store.js");
    expect((await getWork(id))?.status).toBe("assembling");
  });

  it("最近 assembly 评审 fail + final.mp4 存在 → 不转正(2026-08-18 事故回归)", async () => {
    const id = await makeAssemblingWorkWithFinal();
    // 写入 fail 评审结论(评审流未翻案)
    await writeFile(join(dir, "works", id, "eval-assembly-1.json"), JSON.stringify({ verdict: "fail", issues: [] }));
    const rec = await import("../../src/services/reconcile.js");
    rec.initReconcile(() => false);
    await rec.reconcileWorkStates("periodic");
    const { getWork } = await import("../../src/work-store.js");
    expect((await getWork(id))?.status).toBe("assembling");
  });

  it("最近 assembly 评审 pass 后 → 正常转正", async () => {
    const id = await makeAssemblingWorkWithFinal();
    await writeFile(join(dir, "works", id, "eval-assembly-1.json"), JSON.stringify({ verdict: "fail", issues: [] }));
    await writeFile(join(dir, "works", id, "eval-assembly-2.json"), JSON.stringify({ verdict: "pass", issues: [] }));
    const rec = await import("../../src/services/reconcile.js");
    rec.initReconcile(() => false);
    await rec.reconcileWorkStates("periodic");
    const { getWork } = await import("../../src/work-store.js");
    expect((await getWork(id))?.status).toBe("reviewing");
  });
});
