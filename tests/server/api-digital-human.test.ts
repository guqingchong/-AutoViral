import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as configModule from "../../src/config.js";

function mockOkResponse(jsonBody: unknown) {
  const text = JSON.stringify(jsonBody);
  return { ok: true, json: async () => jsonBody, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as any;
}

describe("digital-human API", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      port: 3271, model: "sonnet", jimeng: { accessKey: "", secretKey: "" },
      research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
      chanjing: { appId: "app", secretKey: "secret" },
    } as any);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => closeDb());

  it("imports avatar and submits job end-to-end", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockOkResponse({ access_token: "tok" }))
      .mockResolvedValueOnce(mockOkResponse({ data: { job_id: "job1" } }))
      .mockResolvedValueOnce(mockOkResponse({ access_token: "tok" }))
      .mockResolvedValueOnce(mockOkResponse({ data: { status: 3, video_url: "https://v.mp4" } }))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer } as any);

    const res1 = await apiRoutes.request("/api/digital-humans/avatars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Host", providerAvatarId: "cj_1" }),
    });
    expect(res1.status).toBe(201);
    const avatar = await res1.json();

    const res2 = await apiRoutes.request("/api/digital-humans/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId: avatar.id, audioUrl: "/a.mp3", estimatedCost: 0.5 }),
    });
    expect(res2.status).toBe(201);
    const job = await res2.json();
    await new Promise((r) => setTimeout(r, 50));

    const res3 = await apiRoutes.request(`/api/digital-humans/jobs/${job.id}/refresh`, { method: "POST" });
    expect(res3.status).toBe(200);
    const refreshed = await res3.json();
    expect(refreshed.status).toBe("done");
    if (refreshed.result_local_path) await rm(refreshed.result_local_path, { force: true });
  });
});
