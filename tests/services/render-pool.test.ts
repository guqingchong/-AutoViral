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

  it("syncRenderPool 按作品队列 position 重排（prioritize 后顺序一致）", async () => {
    cfg.digitalHuman = { batchThreshold: 99 }; // 禁止自动触发
    makeAvatar();
    for (const id of ["w1", "w2", "w3"]) {
      makeWork(id);
      queueRepo.enqueue(id);
      await svc.runDigitalHumanForWork(id);
    }
    expect(svc.getRenderPool().map((i) => i.workId)).toEqual(["w1", "w2", "w3"]);

    queueRepo.prioritize("w3");
    svc.syncRenderPool();

    const pool = svc.getRenderPool();
    expect(pool.map((i) => i.workId)).toEqual(["w3", "w1", "w2"]);
    expect(pool[0].queuePosition).toBe(queueRepo.getItem("w3")!.position);
    expect(heygem.submitJob).not.toHaveBeenCalled();
  });

  it("已 paused 的作品跳过不提交，任务保持 queued", async () => {
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

    await svc.triggerRenderNow();
    expect(heygem.submitJob).toHaveBeenCalledTimes(1);
    expect(jobsOf("w1")[0].status).toBe("done");
    expect(jobsOf("w2")[0].status).toBe("queued");
    expect(jobsOf("w2")[0].provider_job_id).toBeUndefined();
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
});
