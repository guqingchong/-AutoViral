import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as configModule from "../../src/config.js";
import { importAvatar, submitJob, refreshJob } from "../../src/services/digital-human.js";

function mockOkResponse(jsonBody: unknown) {
  const text = JSON.stringify(jsonBody);
  return { ok: true, json: async () => jsonBody, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as any;
}

describe("digital-human service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      port: 3271,
      model: "sonnet",
      jimeng: { accessKey: "", secretKey: "" },
      research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
      chanjing: { appId: "app", secretKey: "secret" },
    } as any);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => closeDb());

  it("submits and refreshes a ChanJing job", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockOkResponse({ access_token: "tok" })) // token
      .mockResolvedValueOnce(mockOkResponse({ data: { job_id: "job1" } })) // submit
      .mockResolvedValueOnce(mockOkResponse({ access_token: "tok" })) // token
      .mockResolvedValueOnce(mockOkResponse({ data: { status: 3, video_url: "https://v.mp4" } })) // query
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer } as any); // download

    const avatar = await importAvatar("Host", "cj_avatar_1");
    const job = await submitJob({ avatarId: avatar.id, audioUrl: "/works/w1/assets/audio/voice.mp3", estimatedCost: 0.5 });
    expect(job.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 50));
    const refreshed = await refreshJob(job.id);
    expect(refreshed?.status).toBe("done");
    expect(refreshed?.result_local_path).toContain("output.mp4");
    if (refreshed?.result_local_path) await rm(refreshed.result_local_path, { force: true });
  });
});
