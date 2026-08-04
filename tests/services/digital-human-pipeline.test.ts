import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/heygem-client.js", () => ({
  submitJob: vi.fn(), getJob: vi.fn(), downloadResult: vi.fn(),
}));
vi.mock("../../src/services/instance-service.js", () => ({
  assertReady: vi.fn(), recordActivity: vi.fn(),
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

describe("digital-human-pipeline", () => {
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
  let fakeTts: { generateAudio: ReturnType<typeof vi.fn> };

  // config.ts 的 dataDir 是模块加载时求值的常量，必须先设 env + resetModules 再动态 import
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-dhp-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(cfg);
    vi.spyOn(configModule, "getConfig").mockReturnValue(cfg);
    heygem = await import("../../src/services/heygem-client.js");
    instance = await import("../../src/services/instance-service.js");
    instance.assertReady.mockResolvedValue(undefined);
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
    svc = await import("../../src/services/digital-human-pipeline.js");
  });

  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  function makeAvatar(id: string, isDefault = false) {
    return avatarsRepo.createAvatar({
      id, name: `Avatar ${id}`, status: "ready", source: "heygem",
      reference_video_path: join(dir, "avatars", id, "media.mp4"),
      config: isDefault ? { isDefault: true } : {},
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  function makeWork(id: string, avatarId?: string, voiceId?: string) {
    return worksRepo.createWork({
      id, title: `Work ${id}`, type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false, tags: [],
      digital_human_id: avatarId,
      voice_id: voiceId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, []);
  }

  function makeScript(workId: string, content: unknown) {
    return scriptsRepo.createScript({ work_id: workId, content: content as any, status: "ready" });
  }

  function makeDoneJob(id: string, workId: string, avatarId: string) {
    return jobsRepo.createJob({
      id, work_id: workId, avatar_id: avatarId, audio_path: "/a.mp3",
      provider: "heygem", status: "done", progress: 100,
      estimated_cost: 0, actual_cost: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
  }

  describe("extractNarration", () => {
    it("uses a plain string directly", () => {
      expect(svc.extractNarration("  纯文本口播  ")).toBe("纯文本口播");
    });

    it("picks common narration keys from a JSON object", () => {
      expect(svc.extractNarration({ narration: "口播内容", visual: "画面" })).toBe("口播内容");
      expect(svc.extractNarration({ 口播: "中文键" })).toBe("中文键");
      expect(svc.extractNarration({ voiceover: "vo" })).toBe("vo");
    });

    it("joins narration across scenes", () => {
      const content = {
        scenes: [
          { timestamp: "0:00-0:15", narration: "第一句", visual: "画面一" },
          { timestamp: "0:15-0:30", narration: "第二句", visual: "画面二" },
        ],
        duration: 30,
      };
      expect(svc.extractNarration(content)).toBe("第一句\n第二句");
    });

    it("falls back to concatenating all string values", () => {
      expect(svc.extractNarration({ a: "x", b: ["y", { c: "z" }] })).toBe("x\ny\nz");
    });

    it("returns empty string for empty/invalid content", () => {
      expect(svc.extractNarration({})).toBe("");
      expect(svc.extractNarration(null)).toBe("");
      expect(svc.extractNarration(42)).toBe("");
    });
  });

  describe("runDigitalHumanForWork", () => {
    it("skips when a done job already exists for the work", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1");
      makeScript("w1", { narration: "口播" });
      makeDoneJob("dhjob_done1", "w1", "av1");

      const result = await svc.runDigitalHumanForWork("w1");
      expect(result).toEqual({ jobId: "dhjob_done1", skipped: true });
      expect(fakeTts.generateAudio).not.toHaveBeenCalled();
      expect(heygem.submitJob).not.toHaveBeenCalled();
    });

    it("throws when work has no bound avatar and no default avatar", async () => {
      makeWork("w1");
      makeScript("w1", { narration: "口播" });
      await expect(svc.runDigitalHumanForWork("w1")).rejects.toThrow("未绑定形象且无默认形象");
    });

    it("falls back to the default avatar when work has none bound", async () => {
      makeAvatar("av-default", true);
      makeWork("w1");
      makeScript("w1", { narration: "默认形象口播" });
      heygem.submitJob.mockResolvedValue("hg-1");

      const result = await svc.runDigitalHumanForWork("w1");
      expect(result.skipped).toBe(false);
      const job = jobsRepo.getJob(result.jobId);
      expect(job?.avatar_id).toBe("av-default");
    });

    it("throws when the work has no script narration", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1");
      makeScript("w1", {});
      await expect(svc.runDigitalHumanForWork("w1")).rejects.toThrow("作品无脚本文案");

      const jobsRepoModule = jobsRepo;
      expect(jobsRepoModule.listJobs("w1").length).toBe(0);
    });

    it("generates TTS from the latest script and submits a render job", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1");
      makeScript("w1", { scenes: [{ narration: "第一句" }, { narration: "第二句" }] });
      heygem.submitJob.mockResolvedValue("hg-1");

      const result = await svc.runDigitalHumanForWork("w1");
      expect(result.skipped).toBe(false);
      expect(fakeTts.generateAudio).toHaveBeenCalledWith(
        expect.objectContaining({ text: "第一句\n第二句", workId: "w1", filename: "narration.mp3" })
      );
      const job = jobsRepo.getJob(result.jobId);
      expect(job?.work_id).toBe("w1");
      expect(job?.audio_path).toBe(join(dir, "works", "w1", "assets", "audio", "narration.mp3"));
    });

    it("TTS 使用 work.voice_id 指定的音色", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1", "avc-clone001");
      makeScript("w1", { narration: "克隆音色口播" });
      heygem.submitJob.mockResolvedValue("hg-1");

      const result = await svc.runDigitalHumanForWork("w1");
      expect(result.skipped).toBe(false);
      expect(fakeTts.generateAudio).toHaveBeenCalledWith(
        expect.objectContaining({ voice: "avc-clone001" }),
      );
    });

    it("opts.voice 优先于 work.voice_id", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1", "avc-clone001");
      makeScript("w1", { narration: "口播" });
      heygem.submitJob.mockResolvedValue("hg-1");

      await svc.runDigitalHumanForWork("w1", { voice: "avc-override" });
      expect(fakeTts.generateAudio).toHaveBeenCalledWith(
        expect.objectContaining({ voice: "avc-override" }),
      );
    });
  });

  describe("listPendingWorks", () => {
    it("lists only works with avatar + script and no done job", async () => {
      makeAvatar("av1");
      makeWork("w-ready", "av1");
      makeScript("w-ready", { narration: "口播" });
      makeWork("w-no-script", "av1");
      makeWork("w-no-avatar");
      makeScript("w-no-avatar", { narration: "口播" });
      makeWork("w-done", "av1");
      makeScript("w-done", { narration: "口播" });
      makeDoneJob("dhjob_d1", "w-done", "av1");

      const pending = await svc.listPendingWorks();
      expect(pending.map((w) => w.id)).toEqual(["w-ready"]);
      expect(pending[0].title).toBe("Work w-ready");
    });
  });

  describe("runBatchDigitalHuman", () => {
    it("submits all pending works, polls to done and registers work_assets", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1");
      makeScript("w1", { narration: "口播一" });
      makeWork("w2", "av1");
      makeScript("w2", { narration: "口播二" });
      heygem.submitJob.mockResolvedValueOnce("hg-1").mockResolvedValueOnce("hg-2");
      heygem.getJob.mockImplementation(async (id: string) => ({ job_id: id, status: "succeeded", processing_time_seconds: 60, error: null }));
      heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });

      const state = await svc.runBatchDigitalHuman({ intervalMs: 1 });
      expect(state.running).toBe(false);
      expect(state.total).toBe(2);
      expect(state.submitted).toBe(2);
      expect(state.done).toBe(2);
      expect(state.failed).toBe(0);
      expect(state.errors).toEqual([]);

      const { getDb } = await import("../../src/db/connection.js");
      const assets = getDb().prepare("SELECT * FROM work_assets ORDER BY work_id").all() as any[];
      expect(assets.length).toBe(2);
      expect(assets[0].kind).toBe("digital-human");
      expect(assets[0].mime_type).toBe("video/mp4");
      expect(assets.map((a: any) => a.work_id)).toEqual(["w1", "w2"]);
    });

    it("continues the batch when a single work fails", async () => {
      makeAvatar("av1");
      makeWork("w-ok", "av1");
      makeScript("w-ok", { narration: "口播" });
      makeWork("w-bad", "av1");
      makeScript("w-bad", { narration: "会失败的口播" });
      fakeTts.generateAudio.mockImplementation(async ({ workId }: any) =>
        workId === "w-bad"
          ? { success: false, error: "tts boom" }
          : { success: true, assetPath: join(dir, "works", workId, "assets", "audio", "narration.mp3") }
      );
      heygem.submitJob.mockResolvedValue("hg-ok");
      heygem.getJob.mockResolvedValue({ job_id: "hg-ok", status: "succeeded", processing_time_seconds: 30, error: null });
      heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });

      const state = await svc.runBatchDigitalHuman({ intervalMs: 1 });
      expect(state.total).toBe(2);
      expect(state.done).toBe(1);
      expect(state.failed).toBe(1);
      expect(state.errors.length).toBe(1);
      expect(state.errors[0].workId).toBe("w-bad");
      expect(state.errors[0].error).toContain("tts boom");

      const { getDb } = await import("../../src/db/connection.js");
      const assets = getDb().prepare("SELECT * FROM work_assets").all() as any[];
      expect(assets.length).toBe(1);
      expect(assets[0].work_id).toBe("w-ok");
    });

    it("returns current state when already running, and times out stuck jobs", async () => {
      makeAvatar("av1");
      makeWork("w1", "av1");
      makeScript("w1", { narration: "口播" });
      heygem.submitJob.mockResolvedValue("hg-stuck");
      heygem.getJob.mockResolvedValue({ job_id: "hg-stuck", status: "running", processing_time_seconds: null, error: null });

      const p = svc.runBatchDigitalHuman({ intervalMs: 5, timeoutMs: 50 });
      // 第二批触发：已在跑，直接返回当前状态
      const guard = await svc.runBatchDigitalHuman();
      expect(guard.running).toBe(true);

      const state = await p;
      expect(state.running).toBe(false);
      expect(state.submitted).toBe(1);
      expect(state.failed).toBe(1);
      expect(state.errors[0].error).toContain("轮询超时");
    });

    it("handles an empty pending list", async () => {
      const state = await svc.runBatchDigitalHuman({ intervalMs: 1 });
      expect(state).toMatchObject({ running: false, total: 0, submitted: 0, done: 0, failed: 0, errors: [] });
      expect(state.startedAt).toBeTruthy();
    });
  });

  describe("getBatchState", () => {
    it("returns a defensive copy", () => {
      const s1 = svc.getBatchState();
      s1.errors.push({ workId: "x", error: "y" });
      expect(svc.getBatchState().errors.length).toBe(0);
    });
  });
});
