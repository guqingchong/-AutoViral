import { describe, it, expect, beforeEach, vi } from "vitest";
import { BailianClient } from "../../src/services/bailian-client.js";
import * as configModule from "../../src/config.js";

function mockOkResponse(jsonBody: unknown) {
  const text = JSON.stringify(jsonBody);
  return { ok: true, json: async () => jsonBody, text: async () => text } as any;
}

describe("bailian-client", () => {
  beforeEach(() => {
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({
      port: 3271,
      model: "sonnet",
      jimeng: { accessKey: "", secretKey: "" },
      research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
      bailian: { apiKey: "key" },
    } as any);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("submits video and queries task", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockOkResponse({ output: { task_id: "t1" } }));
    fetchMock.mockResolvedValueOnce(mockOkResponse({ output: { task_status: "SUCCEEDED", video_url: "https://v.mp4" } }));
    const client = new BailianClient();
    const taskId = await client.submitVideo("https://img.jpg", "https://audio.mp3");
    expect(taskId).toBe("t1");
    const result = await client.queryVideo(taskId);
    expect(result.videoUrl).toBe("https://v.mp4");
  });
});
