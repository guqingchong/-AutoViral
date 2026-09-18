import { describe, it, expect } from "vitest";
import { buildCardHtml } from "../../src/services/snapshot-card.js";

// 2026-09-11(镜26 复盘):快照卡正文尾行压字幕带——服务级底部字幕安全区。
describe("snapshot-card 字幕安全区", () => {
  it("safeBottomPct=13 → shot-wrap 底部留白 13% 卡高", () => {
    const html = buildCardHtml({ imagePath: "x.png", width: 1920, height: 1080, safeBottomPct: 13 }, "data:image/png;base64,AA");
    expect(html).toContain("margin-bottom:140px"); // 1080*0.13=140.4 → 140
  });

  it("不传 safeBottomPct → 不留白(图文卡场景不受影响)", () => {
    const html = buildCardHtml({ imagePath: "x.png" }, "data:image/png;base64,AA");
    expect(html).not.toContain('shot-wrap" style='); // shot-wrap 无内联底部留白
  });

  it("安全区在 1080×1350 默认卡上按比例计算", () => {
    const html = buildCardHtml({ imagePath: "x.png", safeBottomPct: 13 }, "data:image/png;base64,AA");
    expect(html).toContain("margin-bottom:176px"); // 1350*0.13=175.5 → 176
  });
});
