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

describe("digital-human API (heygem)", () => {
  let dir: string;
  let apiRoutes: any;
  let heygem: any;

  // config.ts 的 dataDir 是模块加载时求值的常量，必须设 env + resetModules 后动态 import
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-api-dh-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    const configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(cfg);
    vi.spyOn(configModule, "getConfig").mockReturnValue(cfg);
    heygem = await import("../../src/services/heygem-client.js");
    const instance = await import("../../src/services/instance-service.js");
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

  it("uploads avatar video and runs a job end-to-end", async () => {
    const form = new FormData();
    form.append("name", "Host");
    form.append("file", new File([Buffer.from("fake-video")], "skin.mp4", { type: "video/mp4" }));
    const res1 = await apiRoutes.request("/api/digital-humans/avatars", { method: "POST", body: form });
    expect(res1.status).toBe(201);
    const avatar = await res1.json();
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

  it("rejects non-video avatar upload", async () => {
    const form = new FormData();
    form.append("name", "Bad");
    form.append("file", new File([Buffer.from("x")], "photo.jpg", { type: "image/jpeg" }));
    const res = await apiRoutes.request("/api/digital-humans/avatars", { method: "POST", body: form });
    expect(res.status).toBe(500);
  });
});
