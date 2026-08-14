import { describe, it, expect } from "vitest";
import { scoreTemplate } from "../../src/services/template-score.js";
import { contrastRatio, safeZoneFor } from "../../src/services/design-tokens.js";

describe("design-tokens", () => {
  it("白 vs 深蓝对比度高,灰 vs 深蓝对比度低", () => {
    expect(contrastRatio("#f1f5f9", "#0f1b2d")).toBeGreaterThan(8);
    expect(contrastRatio("#334155", "#0f1b2d")).toBeLessThan(2.5);
  });
  it("竖屏安全区大于横屏", () => {
    const v = safeZoneFor({ width: 1080, height: 1920 });
    const h = safeZoneFor({ width: 1920, height: 1080 });
    expect(v.bottom).toBeGreaterThan(h.bottom);
  });
});

describe("scoreTemplate 模板评分", () => {
  const good = {
    canvas: { width: 1080, height: 1920, backgroundColor: "#0f1b2d" },
    variables: [{ name: "title", type: "text" }],
    layers: [
      { id: "bg", type: "shape", fill: "#0f1b2d", start: 0, duration: 8, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
      { id: "title", type: "text", content: "{{title}}", fontSize: 64, color: "#f1f5f9", start: 0.2, duration: 7.8, position: { x: 70, y: 400 }, animations: [{ type: "slidein", duration: 0.4 }] },
    ],
  };

  it("合格模板高分", () => {
    const r = scoreTemplate(good);
    expect(r.score).toBeGreaterThanOrEqual(88);
  });

  it("空 layers 直接 0 分", () => {
    expect(scoreTemplate({ layers: [] }).score).toBe(0);
  });

  it("小字号+低对比+侵入遮挡区 会被扣分", () => {
    const bad = {
      canvas: { width: 1080, height: 1920, backgroundColor: "#0f1b2d" },
      variables: [],
      layers: [
        { id: "tiny", type: "text", content: "固定文案", fontSize: 18, color: "#334155", start: 0, duration: 8, position: { x: 70, y: 1800 } },
      ],
    };
    const r = scoreTemplate(bad);
    const rules = r.issues.map((i) => i.rule);
    expect(rules).toContain("font-size");
    expect(rules).toContain("contrast");
    expect(rules).toContain("safe-zone");
    expect(rules).toContain("variables");
    expect(rules).toContain("motion");
    expect(r.score).toBeLessThanOrEqual(70);
  });
});
