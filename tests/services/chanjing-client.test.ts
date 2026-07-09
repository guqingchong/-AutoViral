import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChanjingClient } from "../../src/services/chanjing-client.js";
import * as configModule from "../../src/config.js";

function mockOkResponse(jsonBody: unknown) {
  const text = JSON.stringify(jsonBody);
  return { ok: true, json: async () => jsonBody, text: async () => text } as any;
}

describe("chanjing-client", () => {
  beforeEach(() => {
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      port: 3271,
      model: "sonnet",
      jimeng: { accessKey: "", secretKey: "" },
      research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
      chanjing: { appId: "app", secretKey: "secret" },
    } as any);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fetches token and lists avatars", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockOkResponse({ access_token: "tok", expires_in: 7200 }));
    fetchMock.mockResolvedValueOnce(mockOkResponse({ data: { avatars: [{ avatar_id: "av1", name: "Avatar 1" }] } }));
    const client = new ChanjingClient();
    const avatars = await client.listAvatars();
    expect(avatars[0].id).toBe("av1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("submits and queries a video job", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockOkResponse({ access_token: "tok" }));
    fetchMock.mockResolvedValueOnce(mockOkResponse({ data: { job_id: "job1" } }));
    const client = new ChanjingClient();
    const submit = await client.submitVideo("av1", "https://example.com/audio.mp3");
    expect(submit.jobId).toBe("job1");
  });
});
