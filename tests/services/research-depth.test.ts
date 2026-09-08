import { describe, it, expect } from "vitest";
import { resolveResearchDepth, getPurpose } from "../../src/services/purpose-presets.js";

// 流水线 v2 批次3:用途×内容形式 → 研究深度档(2026-09-07 业主拍板绑定表)
describe("resolveResearchDepth 深度分级映射", () => {
  it("authority(专业影响力) → full", () => {
    expect(resolveResearchDepth("authority", "policy")).toBe("full");
  });
  it("grow_fans/sell_products → standard", () => {
    expect(resolveResearchDepth("grow_fans", "knowledge")).toBe("standard");
    expect(resolveResearchDepth("sell_products", "review")).toBe("standard");
  });
  it("brand_exposure + 情绪 → quick", () => {
    expect(resolveResearchDepth("brand_exposure", "emotion")).toBe("quick");
  });
  it("quick 用途 + 严肃形式(policy) → 抬到 standard(深度下限)", () => {
    expect(resolveResearchDepth("brand_exposure", "policy")).toBe("standard");
    expect(resolveResearchDepth("drive_traffic", "industry")).toBe("standard");
  });
  it("未配用途/形式 → standard 兜底", () => {
    expect(resolveResearchDepth(undefined, undefined)).toBe("standard");
  });
  it("六用途预设都带 researchDepth 默认档", () => {
    for (const key of ["authority", "grow_fans", "sell_products", "drive_traffic", "brand_exposure", "short_drama"]) {
      expect(getPurpose(key)?.defaults.researchDepth).toBeTruthy();
    }
  });
});
