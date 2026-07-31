import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/heygem-client.js", () => ({
  submitJob: vi.fn(), getJob: vi.fn(), downloadResult: vi.fn(),
}));
vi.mock("../../src/services/instance-service.js", () => ({
  assertReady: vi.fn(), recordActivity: vi.fn(),
}));

import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = {
  port: 3271, model: "sonnet",
  jimeng: { accessKey: "", secretKey: "" },
  research: { enabled: false, schedule: "", platforms: [] },
  budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
  autodl: { token: "t", instanceUuid: "u", publicBaseUrl: "https://u", gpuHourlyRateYuan: 2.18, idleShutdownMinutes: 15 },
  heygem: { apiToken: "s" },
} as any;

describe("digital-human heygem", () => {
  let dir: string;
  let heygem: any;
  let instance: any;
  let configModule: any;
  let svc: typeof import("../../src/services/digital-human.js");

  // config.ts 的 dataDir/CONFIG_DIR 是模块加载时求值的常量，
  // 必须先设 env + vi.resetModules() 再动态 import，避免写入真实用户目录
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-dh-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    configModule = await import("../../src/config.js");
    heygem = await import("../../src/services/heygem-client.js");
    instance = await import("../../src/services/instance-service.js");
    svc = await import("../../src/services/digital-human.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(cfg);
    vi.spyOn(configModule, "getConfig").mockReturnValue(cfg);
    instance.assertReady.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  async function makeAvatar() {
    return svc.createAvatarFromUpload("测试形象", Buffer.from("fake-video"), "skin.mp4");
  }

  it("avatar upload is immediately ready with source heygem", async () => {
    const avatar = await makeAvatar();
    expect(avatar.status).toBe("ready");
    expect(avatar.source).toBe("heygem");
  });

  it("avatar upload rejects non-video file", async () => {
    await expect(svc.createAvatarFromUpload("bad", Buffer.from("x"), "photo.jpg")).rejects.toThrow("源视频");
  });

  it("submit -> refresh done: downloads result and computes cost", async () => {
    const avatar = await makeAvatar();
    heygem.submitJob.mockResolvedValue("hg-1");
    const job = await svc.submitJob({ avatarId: avatar.id, audioUrl: "/tmp/a.wav" });
    expect(job.provider).toBe("heygem");

    heygem.getJob.mockResolvedValue({ job_id: "hg-1", status: "succeeded", processing_time_seconds: 120, error: null });
    heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });
    const done = await svc.refreshJob(job.id);
    expect(done?.status).toBe("done");
    // 120 秒 × 2.18 元/3600 秒 ≈ 0.0727 元
    expect(done?.actual_cost).toBeCloseTo(0.0727, 3);
    expect(instance.recordActivity).toHaveBeenCalled();
    await access(done!.result_local_path!);
  });

  it("submit maps /api/ audio URL back to a local file under dataDir", async () => {
    const avatar = await makeAvatar();
    heygem.submitJob.mockResolvedValue("hg-url");
    await svc.submitJob({ avatarId: avatar.id, audioUrl: "http://127.0.0.1:3271/api/works/w1/assets/audio/a.wav" });
    expect(heygem.submitJob).toHaveBeenCalledWith(join(dir, "works", "w1", "assets", "audio", "a.wav"), avatar.reference_video_path, "pingpong");
  });

  it("submit blocked when budget exceeded", async () => {
    const avatar = await makeAvatar();
    vi.spyOn(configModule, "getConfig").mockReturnValue({ ...cfg, budget: { monthlyLimitYuan: 0.01, dailyLimitYuan: 200, warningThresholdPercent: 80 } });
    await expect(svc.submitJob({ avatarId: avatar.id, audioUrl: "/a.wav", estimatedCost: 1 })).rejects.toThrow("预算");
  });

  it("refresh failed marks job failed", async () => {
    const avatar = await makeAvatar();
    heygem.submitJob.mockResolvedValue("hg-2");
    const job = await svc.submitJob({ avatarId: avatar.id, audioUrl: "/a.wav" });
    heygem.getJob.mockResolvedValue({ job_id: "hg-2", status: "failed", processing_time_seconds: null, error: "face not found" });
    const res = await svc.refreshJob(job.id);
    expect(res?.status).toBe("failed");
    expect(res?.error).toContain("face not found");
  });

  it("deleteJob removes record and file; regenerateJob resubmits same params", async () => {
    const avatar = await makeAvatar();
    heygem.submitJob.mockResolvedValueOnce("hg-3");
    const job = await svc.submitJob({ avatarId: avatar.id, audioUrl: "/a.wav" });
    heygem.getJob.mockResolvedValue({ job_id: "hg-3", status: "succeeded", processing_time_seconds: 60, error: null });
    heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });
    await svc.refreshJob(job.id);

    heygem.submitJob.mockResolvedValueOnce("hg-4");
    const regen = await svc.regenerateJob(job.id);
    expect(regen.id).not.toBe(job.id);
    expect(regen.avatar_id).toBe(avatar.id);

    expect(await svc.deleteJob(job.id)).toBe(true);
  });
});
