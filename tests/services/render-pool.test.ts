import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/heygem-client.js", () => ({
  submitJob: vi.fn(), getJob: vi.fn(), downloadResult: vi.fn(),
}));
vi.mock("../../src/services/instance-service.js", () => ({
  assertReady: vi.fn(), recordActivity: vi.fn(), getInstanceView: vi.fn(),
}));
vi.mock("../../src/providers/registry.js", () => ({
  getProvider: vi.fn(),
  getDefaultProvider: vi.fn(),
  registerProvider: vi.fn(),
  initProviders: vi.fn(),
  listProviders: vi.fn(() => []),
}));

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = {
  port: 3271, model: "sonnet",
  jimeng: { accessKey: "", secretKey: "" },
  research: { enabled: false, schedule: "", platforms: [] },
  budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
  heygem: { apiToken: "s", baseUrl: "https://u", gpuHourlyRateYuan: 2.18, idleReminderMinutes: 15 },
  minimax: { apiKey: "fake-key" },
} as any;

const INSTANCE_READY = {
  state: "ready", gpuHourlyRateYuan: 2.18, idleReminderMinutes: 15,
  lastActivityAt: null, idleMinutes: 0, consoleUrl: "https://www.autodl.com/console",
};
const INSTANCE_OFFLINE = { ...INSTANCE_READY, state: "offline" };

describe("render-pool（渲染池攒批 + 队列对齐）", () => {
  let dir: string;
  let heygem: any;
  let instance: any;
  let registry: any;
  let configModule: any;
  let svc: typeof import("../../src/services/digital-human-pipeline.js");
  let worksRepo: typeof import("../../src/db/works-repo.js");
  let scriptsRepo: typeof import("../../src/db/scripts-repo.js");
  let avatarsRepo: typeof import("../../src/db/avatars-repo.js");
  let jobsRepo: typeof import("../../src/db/digital-human-jobs-repo.js");
  let queueRepo: typeof import("../../src/db/work-queue-repo.js");
  let fakeTts: { generateAudio: ReturnType<typeof vi.fn> };

  // config.ts 的 dataDir 是模块加载时求值的常量，必须先设 env + resetModules 再动态 import
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-rp-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    delete cfg.digitalHuman;
    configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(cfg);
    vi.spyOn(configModule, "getConfig").mockReturnValue(cfg);
    heygem = await import("../../src/services/heygem-client.js");
    instance = await import("../../src/services/instance-service.js");
    instance.assertReady.mockResolvedValue(undefined);
    instance.getInstanceView.mockResolvedValue(INSTANCE_READY);
    registry = await import("../../src/providers/registry.js");
    fakeTts = {
      generateAudio: vi.fn(async ({ workId, filename }: any) => ({
        success: true,
        assetPath: join(dir, "works", workId, "assets", "audio", filename),
        previewUrl: `/api/works/${workId}/assets/audio/${filename}`,
      })),
    };
    registry.getDefaultProvider.mockReturnValue(fakeTts);
    worksRepo = await import("../../src/db/works-repo.js");
    scriptsRepo = await import("../../src/db/scripts-repo.js");
    avatarsRepo = await import("../../src/db/avatars-repo.js");
    jobsRepo = await import("../../src/db/digital-human-jobs-repo.js");
    queueRepo = await import("../../src/db/work-queue-repo.js");
    svc = await import("../../src/services/digital-human-pipeline.js");
  });

  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  function makeAvatar(id = "av1") {
    return avatarsRepo.createAvatar({
      id, name: `Avatar ${id}`, status: "ready", source: "heygem",
      reference_video_path: join(dir, "avatars", id, "media.mp4"),
      config: {},
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  function makeWork(id: string, avatarId = "av1") {
    worksRepo.createWork({
      id, title: `Work ${id}`, type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false, tags: [],
      digital_human_id: avatarId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, []);
    scriptsRepo.createScript({ work_id: id, content: { narration: `口播 ${id}` } as any, status: "ready" });
  }

  function mockHeygemSuccess() {
    heygem.submitJob.mockImplementation(async () => `hg-${heygem.submitJob.mock.calls.length}`);
    heygem.getJob.mockImplementation(async (id: string) => ({ job_id: id, status: "succeeded", processing_time_seconds: 30, error: null }));
    heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });
  }

  function jobsOf(workId: string) {
    return jobsRepo.listJobs(workId);
  }

  it("入池建 queued 任务并记录作品队列 position，不立即提交 HeyGem", async () => {
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1");

    const result = await svc.runDigitalHumanForWork("w1");
    expect(result.skipped).toBe(false);
    const job = jobsRepo.getJob(result.jobId);
    expect(job?.status).toBe("queued");
    expect(job?.queue_position).toBe(queueRepo.getItem("w1")!.position);
    expect(job?.provider_job_id).toBeUndefined();
    // 攒批未到阈值：等一拍确认没有提交
    await new Promise((r) => setTimeout(r, 20));
    expect(heygem.submitJob).not.toHaveBeenCalled();
  });

  it("入池时按口播时长估算成本写入 estimated_cost（非 0）", async () => {
    makeAvatar();
    makeWork("w1"); // cfg.heygem.gpuHourlyRateYuan = 2.18，口播文案短 → 10 秒起步
    queueRepo.enqueue("w1");

    const result = await svc.runDigitalHumanForWork("w1");
    const job = jobsRepo.getJob(result.jobId)!;
    // 10s × 2.18 元/h ÷ 3600 ≈ 0.0061
    expect(job.estimated_cost).toBeGreaterThan(0);
    expect(job.estimated_cost).toBeCloseTo((10 * 2.18) / 3600, 4);
  });

  it("并发触发只提交一次，无任务被错标 failed", async () => {
    cfg.digitalHuman = { batchThreshold: 1 };
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1");
    mockHeygemSuccess();

    await svc.runDigitalHumanForWork("w1");
    // 两个并发触发（阈值已满 + 手动）：共享同一 in-flight 批次
    const [s1, s2] = await Promise.all([svc.maybeTriggerRenderBatch(), svc.triggerRenderNow()]);
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    const job = jobsOf("w1")[0];
    expect(job.status).toBe("done");
    const states = [s1, s2].filter(Boolean) as Array<{ failed: number }>;
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) expect(s.failed).toBe(0);
  });

  it("实例上线通知无条件清 pendingBoot（阈值未满不渲染也不残留开机提示）", async () => {
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1"); // 队列有 queued → 条件 b 不满足；池内 1 个 < 阈值 3 → 不触发
    instance.getInstanceView.mockResolvedValue(INSTANCE_OFFLINE);

    await svc.runDigitalHumanForWork("w1");
    await svc.triggerRenderNow(); // 离线：置 pendingBoot
    expect(svc.getPendingBoot()).toBe(true);

    await svc.onInstanceReady(); // 上线但未到触发条件
    expect(svc.getPendingBoot()).toBe(false);
    expect(heygem.submitJob).not.toHaveBeenCalled();
  });

  it("不在作品队列的作品排在池尾", async () => {
    makeAvatar();
    makeWork("w-inq");
    queueRepo.enqueue("w-inq"); // position 1
    makeWork("w-out");          // 不入队

    await svc.runDigitalHumanForWork("w-inq");
    const r2 = await svc.runDigitalHumanForWork("w-out");
    const outJob = jobsRepo.getJob(r2.jobId)!;
    expect(outJob.queue_position).toBeGreaterThan(queueRepo.getItem("w-inq")!.position);
  });

  it("阈值触发：入池 2 个不提交，第 3 个按队列顺序集中提交并渲染完成", async () => {
    makeAvatar();
    for (const id of ["w1", "w2", "w3"]) {
      makeWork(id);
      queueRepo.enqueue(id);
    }
    mockHeygemSuccess();

    await svc.runDigitalHumanForWork("w1");
    await svc.runDigitalHumanForWork("w2");
    await new Promise((r) => setTimeout(r, 20));
    expect(heygem.submitJob).not.toHaveBeenCalled();

    await svc.runDigitalHumanForWork("w3"); // 达到默认阈值 3，后台触发
    await vi.waitFor(() => expect(heygem.submitJob).toHaveBeenCalledTimes(3));

    // 提交顺序严格等于作品队列顺序
    const submittedAudio = heygem.submitJob.mock.calls.map((c: any[]) => c[0] as string);
    expect(submittedAudio.map((p: string) => p.split(/[\\/]works[\\/]/)[1].split(/[\\/]/)[0])).toEqual(["w1", "w2", "w3"]);

    await vi.waitFor(() => expect(svc.getBatchState().done).toBe(3));
    for (const id of ["w1", "w2", "w3"]) {
      expect(jobsOf(id)[0].status).toBe("done");
    }
    expect(svc.getPendingBoot()).toBe(false);
  });

  it("batchThreshold 可配置：设为 2 时入池 2 个即触发", async () => {
    cfg.digitalHuman = { batchThreshold: 2 };
    makeAvatar();
    makeWork("w1");
    makeWork("w2");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");
    mockHeygemSuccess();

    await svc.runDigitalHumanForWork("w1");
    await new Promise((r) => setTimeout(r, 20));
    expect(heygem.submitJob).not.toHaveBeenCalled();

    await svc.runDigitalHumanForWork("w2");
    await vi.waitFor(() => expect(heygem.submitJob).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(svc.getBatchState().done).toBe(2));
  });

  it("队列空闲且池内最久等待超 10 分钟时触发（条件 b）", async () => {
    makeAvatar();
    makeWork("w1"); // 不入队 → 队列无 queued/running
    mockHeygemSuccess();

    const { jobId } = await svc.runDigitalHumanForWork("w1");
    await new Promise((r) => setTimeout(r, 20));
    expect(heygem.submitJob).not.toHaveBeenCalled(); // 等待时长不足，未触发

    // 把任务的入池时间回拨 11 分钟
    const { getDb } = await import("../../src/db/connection.js");
    getDb()
      .prepare("UPDATE digital_human_jobs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), jobId);

    const state = await svc.maybeTriggerRenderBatch();
    expect(state).not.toBeNull();
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("done");
  });

  it("实例离线：手动触发不提交，任务保持 queued 且 pendingBoot=true", async () => {
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1");
    instance.getInstanceView.mockResolvedValue(INSTANCE_OFFLINE);

    await svc.runDigitalHumanForWork("w1");
    const state = await svc.triggerRenderNow();

    expect(heygem.submitJob).not.toHaveBeenCalled();
    expect(jobsOf("w1")[0].status).toBe("queued");
    expect(svc.getPendingBoot()).toBe(true);
    expect(state.submitted).toBe(0);

    // 实例上线后手动触发可恢复渲染，pendingBoot 清除
    instance.getInstanceView.mockResolvedValue(INSTANCE_READY);
    mockHeygemSuccess();
    await svc.triggerRenderNow();
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("done");
    expect(svc.getPendingBoot()).toBe(false);
  });

  it("syncRenderPool 按作品队列 position 重排（prioritize 后顺序一致，paused 作品同样重排）", async () => {
    cfg.digitalHuman = { batchThreshold: 99 }; // 禁止自动触发
    makeAvatar();
    for (const id of ["w1", "w2", "w3"]) {
      makeWork(id);
      queueRepo.enqueue(id);
      await svc.runDigitalHumanForWork(id);
    }
    expect(svc.getRenderPool().map((i) => i.workId)).toEqual(["w1", "w2", "w3"]);

    queueRepo.setStatus("w3", "paused"); // paused 只影响提交，不影响重排
    queueRepo.prioritize("w3");          // prioritize 会把状态置回 queued，先 pause 再插队的位次仍应同步
    queueRepo.setStatus("w3", "paused");
    svc.syncRenderPool();

    const pool = svc.getRenderPool();
    expect(pool.map((i) => i.workId)).toEqual(["w3", "w1", "w2"]);
    expect(pool[0].queuePosition).toBe(queueRepo.getItem("w3")!.position);
    expect(heygem.submitJob).not.toHaveBeenCalled();
  });

  it("已 paused 的作品跳过不提交，任务保持 queued 且不计入 total", async () => {
    makeAvatar();
    makeWork("w1");
    makeWork("w2");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");
    mockHeygemSuccess();

    await svc.runDigitalHumanForWork("w1");
    await svc.runDigitalHumanForWork("w2");
    queueRepo.setStatus("w2", "paused");
    svc.syncRenderPool();

    const state = await svc.triggerRenderNow();
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("done");
    expect(jobsOf("w2")[0].status).toBe("queued");
    expect(jobsOf("w2")[0].provider_job_id).toBeUndefined();
    expect(state.total).toBe(1); // paused 不计入 total，进度 submitted+failed 能对上 total
    expect(state.submitted + state.failed).toBe(state.total);
  });

  it("作品移出队列后 syncRenderPool 取消其未提交的渲染任务", async () => {
    cfg.digitalHuman = { batchThreshold: 99 };
    makeAvatar();
    makeWork("w1");
    makeWork("w2");
    queueRepo.enqueue("w1");
    queueRepo.enqueue("w2");
    await svc.runDigitalHumanForWork("w1");
    await svc.runDigitalHumanForWork("w2");

    queueRepo.removeItem("w1");
    svc.syncRenderPool();

    const cancelled = jobsOf("w1")[0];
    expect(cancelled.status).toBe("failed");
    expect(cancelled.error).toContain("取消");
    expect(jobsOf("w2")[0].status).toBe("queued");
    expect(svc.getRenderPool().map((i) => i.workId)).toEqual(["w2"]);
  });

  // ── C1: 周期性评估 + 超时触发与队列忙闲无关 ──────────────────────────────

  it("C1: 调度器按注入间隔周期调用 tick，stop 后不再触发", async () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      svc.startRenderPoolScheduler({ intervalMs: 60_000, tick });
      expect(tick).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(tick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(120_000);
      expect(tick).toHaveBeenCalledTimes(3);

      // 重复 start 幂等（不叠加第二个 interval）
      svc.startRenderPoolScheduler({ intervalMs: 60_000, tick });
      vi.advanceTimersByTime(60_000);
      expect(tick).toHaveBeenCalledTimes(4);

      svc.stopRenderPoolScheduler();
      vi.advanceTimersByTime(300_000);
      expect(tick).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C1: 超时触发不再被队列忙碌阻塞（running 作品等渲染的场景）", async () => {
    cfg.digitalHuman = { batchThreshold: 99 }; // 阈值路径不触发，只验超时路径
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1");
    queueRepo.setStatus("w1", "running"); // 队列忙碌：该作品正在流水线里等渲染
    mockHeygemSuccess();

    const { jobId } = await svc.runDigitalHumanForWork("w1");
    await new Promise((r) => setTimeout(r, 20));
    expect(heygem.submitJob).not.toHaveBeenCalled();

    // 入池时间回拨 11 分钟 —— 旧逻辑 queueBusy 会判忙碌永不触发（死锁），
    // 新逻辑池内有 queued 且最久等待 >10 分钟即触发
    const { getDb } = await import("../../src/db/connection.js");
    getDb()
      .prepare("UPDATE digital_human_jobs SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 11 * 60_000).toISOString(), jobId);

    const state = await svc.maybeTriggerRenderBatch();
    expect(state).not.toBeNull();
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("done");
  });

  // ── I2: 入池去重 ────────────────────────────────────────────────────────

  it("I2: 同作品重复入池复用已有 queued 任务（不重复 TTS、不新建 job）", async () => {
    cfg.digitalHuman = { batchThreshold: 99 };
    makeAvatar();
    makeWork("w1");
    queueRepo.enqueue("w1");

    const r1 = await svc.runDigitalHumanForWork("w1");
    const r2 = await svc.runDigitalHumanForWork("w1");

    expect(r2.jobId).toBe(r1.jobId);
    expect(r2.skipped).toBe(false); // 复用 queued 任务（非 done 兜底）
    expect(jobsOf("w1")).toHaveLength(1);
    expect(fakeTts.generateAudio).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("queued");
  });

  // ── I3: 重启接管 running 渲染任务 ────────────────────────────────────────

  it("I3: 重启后接管 running 任务：轮询 → finalize → 登记作品产物", async () => {
    makeAvatar();
    makeWork("w1");
    // 模拟上一进程遗留：已提交 HeyGem（有 provider_job_id）但进程死亡时仍 running
    jobsRepo.createJob({
      id: "dhjob_restart1",
      work_id: "w1",
      avatar_id: "av1",
      audio_path: join(dir, "works", "w1", "assets", "audio", "narration.mp3"),
      provider: "heygem",
      status: "running",
      progress: 50,
      estimated_cost: 0.01,
      actual_cost: 0,
      provider_job_id: "hg-restart-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    mockHeygemSuccess();

    const recovered = await svc.recoverRunningRenderJobs({ intervalMs: 1, timeoutMs: 5_000 });
    expect(recovered).toBe(1);

    const job = jobsRepo.getJob("dhjob_restart1")!;
    expect(job.status).toBe("done");
    expect(job.result_local_path).toBeTruthy();

    // registerWorkAsset 链路恢复：产物已登记到 work_assets
    const { getDb } = await import("../../src/db/connection.js");
    const asset = getDb()
      .prepare("SELECT * FROM work_assets WHERE work_id = ? AND kind = 'digital-human'")
      .get("w1") as any;
    expect(asset).toBeDefined();
    expect(asset.path).toBe(job.result_local_path);
  });

  it("I3: 无遗留 running 任务时接管立即返回 0，不触碰 HeyGem", async () => {
    const recovered = await svc.recoverRunningRenderJobs({ intervalMs: 1, timeoutMs: 100 });
    expect(recovered).toBe(0);
    expect(heygem.getJob).not.toHaveBeenCalled();
  });
});
