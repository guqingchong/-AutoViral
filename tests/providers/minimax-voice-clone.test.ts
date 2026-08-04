import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  uploadVoiceCloneFile, cloneVoiceOnMiniMax, listSystemVoices,
} from "../../src/providers/minimax-voice-clone.js";

const cfg = { apiKey: "k" };

describe("minimax-voice-clone", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uploadVoiceCloneFile posts multipart and returns file_id", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ file: { file_id: 123 }, base_resp: { status_code: 0 } }),
    });
    const id = await uploadVoiceCloneFile(cfg, Buffer.from("audio"), "sample.mp3");
    expect(id).toBe(123);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://api.minimax.chat/v1/files/upload");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("uploadVoiceCloneFile appends GroupId when configured", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ file: { file_id: 1 }, base_resp: { status_code: 0 } }),
    });
    await uploadVoiceCloneFile({ apiKey: "k", groupId: "g9" }, Buffer.from("a"), "s.mp3");
    expect((fetch as any).mock.calls[0][0]).toBe("https://api.minimax.chat/v1/files/upload?GroupId=g9");
  });

  it("cloneVoiceOnMiniMax resolves on status_code 0", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ base_resp: { status_code: 0, status_msg: "success" } }),
    });
    await expect(cloneVoiceOnMiniMax(cfg, 123, "avc-abc123")).resolves.toBeUndefined();
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ file_id: 123, voice_id: "avc-abc123" });
  });

  it("cloneVoiceOnMiniMax throws with MiniMax message on failure", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ base_resp: { status_code: 1002, status_msg: "audio too short" } }),
    });
    await expect(cloneVoiceOnMiniMax(cfg, 123, "avc-abc123")).rejects.toThrow("audio too short");
  });

  it("listSystemVoices returns system_voice array", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        system_voice: [{ voice_id: "male-qn-qingse", name: "青涩青年" }],
        base_resp: { status_code: 0 },
      }),
    });
    const voices = await listSystemVoices(cfg);
    expect(voices[0].voice_id).toBe("male-qn-qingse");
  });
});
