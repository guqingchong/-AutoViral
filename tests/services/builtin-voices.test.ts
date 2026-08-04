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

  it("回退结果短缓存：TTL 内不重试，过期后重新拉取动态列表", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-08-04T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      client.listSystemVoices.mockRejectedValue(new Error("network"));
      const first = await svc.listBuiltinVoices();
      expect(first.length).toBeGreaterThanOrEqual(8); // 静态回退

      client.listSystemVoices.mockResolvedValue([{ voice_id: "male-qn-qingse" }]);

      // 回退 TTL 内：仍返回静态缓存，不再请求 API
      vi.setSystemTime(t0 + 4 * 60 * 1000);
      const second = await svc.listBuiltinVoices();
      expect(second).toBe(first);
      expect(client.listSystemVoices).toHaveBeenCalledTimes(1);

      // 回退 TTL 过期后：重新拉取并返回增强后的动态列表
      vi.setSystemTime(t0 + svc.FALLBACK_CACHE_TTL_MS + 1000);
      const third = await svc.listBuiltinVoices();
      expect(client.listSystemVoices).toHaveBeenCalledTimes(2);
      expect(third).toHaveLength(1);
      expect(third[0]).toMatchObject({ voice_id: "male-qn-qingse", name: "清朗男声", category: "男声" });
    } finally {
      vi.useRealTimers();
    }
  });
});
