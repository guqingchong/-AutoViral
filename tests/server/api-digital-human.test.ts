import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/heygem-client.js", () => ({
  submitJob: vi.fn(), getJob: vi.fn(), downloadResult: vi.fn(),
}));
vi.mock("../../src/services/instance-service.js", () => ({
  assertReady: vi.fn(), recordActivity: vi.fn(),
  getInstanceView: vi.fn(),
}));

import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = {
  port: 3271, model: "sonnet",
  jimeng: { accessKey: "", secretKey: "" },
  research: { enabled: false, schedule: "", platforms: [] },
  budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
  heygem: {
    apiToken: "s", baseUrl: "https://u", gpuHourlyRateYuan: 2.18, idleReminderMinutes: 15,
    tunnel: { host: "connect.nmb1.seetacloud.com", port: 28830, user: "root", localPort: 6006, remotePort: 6008 },
  },
} as any;

describe("digital-human API (heygem)", () => {
  let dir: string;
  let apiRoutes: any;
  let heygem: any;
  let instance: any;
  let configModule: any;

  // config.ts 的 dataDir 是模块加载时求值的常量，必须设 env + resetModules 后动态 import
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-api-dh-"));
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
    ({ apiRoutes } = await import("../../src/server/api.js"));
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  async function makeAvatar(): Promise<any> {
    const form = new FormData();
    form.append("name", "Host");
    form.append("file", new File([Buffer.from("fake-video")], "skin.mp4", { type: "video/mp4" }));
    const res = await apiRoutes.request("/api/digital-humans/avatars", { method: "POST", body: form });
    expect(res.status).toBe(201);
    return res.json();
  }

  async function makeJob(avatarId: string): Promise<any> {
    heygem.submitJob.mockResolvedValueOnce("hg-api-1");
    const res = await apiRoutes.request("/api/digital-humans/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId, audioUrl: "/a.wav", estimatedCost: 0.5 }),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("uploads avatar video and runs a job end-to-end", async () => {
    const avatar = await makeAvatar();
    expect(avatar.status).toBe("ready");
    expect(avatar.source).toBe("heygem");

    heygem.submitJob.mockResolvedValue("hg-api-1");
    const res2 = await apiRoutes.request("/api/digital-humans/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId: avatar.id, audioUrl: "/a.wav", estimatedCost: 0.5 }),
    });
    expect(res2.status).toBe(201);
    const job = await res2.json();
    expect(job.provider).toBe("heygem");
    expect(job.provider_job_id).toBe("hg-api-1");

    heygem.getJob.mockResolvedValue({ job_id: "hg-api-1", status: "succeeded", processing_time_seconds: 120, error: null });
    heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });
    const res3 = await apiRoutes.request(`/api/digital-humans/jobs/${job.id}/refresh`, { method: "POST" });
    expect(res3.status).toBe(200);
    const refreshed = await res3.json();
    expect(refreshed.status).toBe("done");
    expect(refreshed.actual_cost).toBeCloseTo(0.0727, 3);
    await access(refreshed.result_local_path);
  });

  it("rejects non-video avatar upload with 400", async () => {
    const form = new FormData();
    form.append("name", "Bad");
    form.append("file", new File([Buffer.from("x")], "photo.jpg", { type: "image/jpeg" }));
    const res = await apiRoutes.request("/api/digital-humans/avatars", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  it("config-status reports heygemConfigured boolean", async () => {
    const res = await apiRoutes.request("/api/digital-humans/config-status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ heygemConfigured: true });

    vi.spyOn(configModule, "loadConfig").mockResolvedValue({ ...cfg, heygem: undefined });
    const res2 = await apiRoutes.request("/api/digital-humans/config-status");
    expect(await res2.json()).toEqual({ heygemConfigured: false });

    // baseUrl 缺失也视为未配置
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({ ...cfg, heygem: { ...cfg.heygem, baseUrl: "" } });
    const res3 = await apiRoutes.request("/api/digital-humans/config-status");
    expect(await res3.json()).toEqual({ heygemConfigured: false });

    // tunnel.host 缺失也视为未配置
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      ...cfg,
      heygem: { ...cfg.heygem, tunnel: { ...cfg.heygem.tunnel, host: "" } },
    });
    const res4 = await apiRoutes.request("/api/digital-humans/config-status");
    expect(await res4.json()).toEqual({ heygemConfigured: false });
  });

  it("GET/PUT /api/config 暴露 heygem 隧道扁平字段", async () => {
    // GET /api/config 需要 analytics 字段（flattenAnalytics）
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      ...cfg,
      analytics: { enabled: false, collectInterval: 60, sources: [] },
    });
    const res = await apiRoutes.request("/api/config");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.heygemTunnelHost).toBe("connect.nmb1.seetacloud.com");
    expect(data.heygemTunnelPort).toBe(28830);

    const put = await apiRoutes.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heygemTunnelHost: "connect.example.com", heygemTunnelPort: 30000 }),
    });
    expect(put.status).toBe(200);
    const saved = await put.json();
    expect(saved.heygem.tunnel.host).toBe("connect.example.com");
    expect(saved.heygem.tunnel.port).toBe(30000);
    // 其余 tunnel 字段补默认值
    expect(saved.heygem.tunnel.user).toBe("root");
    expect(saved.heygem.tunnel.localPort).toBe(6006);
    expect(saved.heygem.tunnel.remotePort).toBe(6008);
    // 恢复 cfg，避免影响后续用例
    cfg.heygem.tunnel.host = "connect.nmb1.seetacloud.com";
    cfg.heygem.tunnel.port = 28830;
  });

  it("instance status returns InstanceView", async () => {
    instance.getInstanceView.mockResolvedValue({ state: "ready", gpuHourlyRateYuan: 2.18, idleReminderMinutes: 15, lastActivityAt: null, idleMinutes: 0, consoleUrl: "https://www.autodl.com/console" });
    const res = await apiRoutes.request("/api/digital-humans/instance/status");
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("ready");
  });

  it("submit job returns 409 when instance not ready", async () => {
    const avatar = await makeAvatar();
    instance.assertReady.mockRejectedValue(new Error("实例离线，请先到 AutoDL 控制台开机"));
    const res = await apiRoutes.request("/api/digital-humans/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId: avatar.id, audioUrl: "/a.wav" }),
    });
    expect(res.status).toBe(409);
  });

  it("DELETE job removes existing job and 404s on unknown id", async () => {
    const avatar = await makeAvatar();
    const job = await makeJob(avatar.id);

    const res = await apiRoutes.request(`/api/digital-humans/jobs/${job.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const res2 = await apiRoutes.request("/api/digital-humans/jobs/dhjob_missing", { method: "DELETE" });
    expect(res2.status).toBe(404);
  });

  it("DELETE avatar rejects path-escape and unknown ids with 404", async () => {
    const res = await apiRoutes.request("/api/digital-humans/avatars/..%2F..%2F..%2Fetc", { method: "DELETE" });
    expect(res.status).toBe(404);

    const res2 = await apiRoutes.request("/api/digital-humans/avatars/avatar_00000000-0000-0000-0000-000000000000", { method: "DELETE" });
    expect(res2.status).toBe(404);
  });

  it("DELETE avatar returns 409 while it has active jobs, deletes after they finish", async () => {
    const avatar = await makeAvatar();
    const job = await makeJob(avatar.id);

    const res = await apiRoutes.request(`/api/digital-humans/avatars/${avatar.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("无法删除");

    // 任务结束后（无进行中任务）可正常删除
    heygem.getJob.mockResolvedValue({ job_id: "hg-api-1", status: "succeeded", processing_time_seconds: 10, error: null });
    heygem.downloadResult.mockImplementation(async (_id: string, dest: string) => { await writeFile(dest, "mp4"); });
    await apiRoutes.request(`/api/digital-humans/jobs/${job.id}/refresh`, { method: "POST" });

    const res2 = await apiRoutes.request(`/api/digital-humans/avatars/${avatar.id}`, { method: "DELETE" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ deleted: true });
  });

  it("DELETE job rejects path-escape ids with 404", async () => {
    const res = await apiRoutes.request("/api/digital-humans/jobs/..%2F..%2F..%2Fetc", { method: "DELETE" });
    expect(res.status).toBe(404);
    const res2 = await apiRoutes.request("/api/digital-humans/jobs/avatar_00000000-0000-0000-0000-000000000000", { method: "DELETE" });
    expect(res2.status).toBe(404);
  });

  it("regenerate returns 201 with a new job; 404 on unknown id", async () => {
    const avatar = await makeAvatar();
    const job = await makeJob(avatar.id);

    heygem.submitJob.mockResolvedValueOnce("hg-api-2");
    const res = await apiRoutes.request(`/api/digital-humans/jobs/${job.id}/regenerate`, { method: "POST" });
    expect(res.status).toBe(201);
    const regen = await res.json();
    expect(regen.id).not.toBe(job.id);
    expect(regen.avatar_id).toBe(avatar.id);
    expect(regen.provider_job_id).toBe("hg-api-2");

    const res2 = await apiRoutes.request("/api/digital-humans/jobs/dhjob_missing/regenerate", { method: "POST" });
    expect(res2.status).toBe(404);
  });
});
