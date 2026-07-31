import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../../src/config.js";
import { checkHealth, submitJob, getJob, downloadResult } from "../../src/services/heygem-client.js";

const baseConfig = {
  port: 3271, model: "sonnet",
  jimeng: { accessKey: "", secretKey: "" },
  research: { enabled: false, schedule: "", platforms: [] },
  heygem: { apiToken: "secret", baseUrl: "https://u.autodl.com", gpuHourlyRateYuan: 1.78, idleReminderMinutes: 15 },
} as any;

function mockJson(body: unknown) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) } as any;
}

describe("heygem-client", () => {
  beforeEach(() => {
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(baseConfig);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("health returns true on ok", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockJson({ status: "ok", gpu_available: true }));
    expect(await checkHealth()).toBe(true);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://u.autodl.com/api/health");
    expect(init.headers.Authorization).toBe("Bearer secret");
  });

  it("health returns false on network error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await checkHealth()).toBe(false);
  });

  it("submitJob posts multipart form and returns job_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-hg-"));
    const audio = join(dir, "a.wav");
    const video = join(dir, "v.mp4");
    await writeFile(audio, "fake-audio");
    await writeFile(video, "fake-video");
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockJson({ job_id: "j-1", status: "queued" }));
    const id = await submitJob(audio, video, "pingpong");
    expect(id).toBe("j-1");
    await rm(dir, { recursive: true, force: true });
  });

  it("getJob maps fields", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockJson({
      job_id: "j-1", status: "succeeded", processing_time_seconds: 94.2, error: null,
    }));
    const job = await getJob("j-1");
    expect(job.status).toBe("succeeded");
    expect(job.processing_time_seconds).toBeCloseTo(94.2);
  });

  it("getJob passes an AbortSignal to fetch", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockJson({
      job_id: "j-1", status: "running", processing_time_seconds: null, error: null,
    }));
    await getJob("j-1");
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("getJob throws semantic error on timeout", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(getJob("j-1")).rejects.toThrow("HeyGem 查询超时");
  });

  it("downloadResult writes file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-hg-"));
    const dest = join(dir, "out.mp4");
    const bytes = new TextEncoder().encode("mp4-bytes");
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true, arrayBuffer: async () => bytes.buffer,
    } as any);
    await downloadResult("j-1", dest);
    expect(await readFile(dest)).toEqual(Buffer.from(bytes));
    await rm(dir, { recursive: true, force: true });
  });
});
