import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/providers/minimax-voice-clone.js", () => ({
  uploadVoiceCloneFile: vi.fn(), cloneVoiceOnMiniMax: vi.fn(), listSystemVoices: vi.fn(),
}));

describe("builtin-voices", () => {
  let svc: typeof import("../../src/services/builtin-voices.js");
  let client: any;

  beforeEach(async () => {
    vi.resetModules();
    const configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({ minimax: { apiKey: "k" } } as any);
    client = await import("../../src/providers/minimax-voice-clone.js");
    svc = await import("../../src/services/builtin-voices.js");
  });
  afterEach(() => vi.restoreAllMocks());

  it("合并 API 全量列表与分类映射，未知音色归入其他", async () => {
    client.listSystemVoices.mockResolvedValue([
      { voice_id: "male-qn-qingse" },
      { voice_id: "some_new_voice_x" },
    ]);
    const voices = await svc.listBuiltinVoices();
    expect(voices).toHaveLength(2);
    expect(voices.find((v) => v.voice_id === "male-qn-qingse")).toMatchObject({ name: "清朗男声", category: "男声" });
    expect(voices.find((v) => v.voice_id === "some_new_voice_x")?.category).toBe("其他");
  });

  it("API 失败时回退静态精选列表（含分类）", async () => {
    client.listSystemVoices.mockRejectedValue(new Error("network"));
    const voices = await svc.listBuiltinVoices();
    expect(voices.length).toBeGreaterThanOrEqual(8);
    expect(voices.every((v) => v.name && v.category)).toBe(true);
  });
});
