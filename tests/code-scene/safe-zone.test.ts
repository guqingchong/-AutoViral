import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("字幕安全区三方一致性(2026-09-01 视觉升级)", () => {
  it("layout.ts 导出 SUBTITLE_ZONE 458-602 / MARGIN 96", () => {
    const src = readFileSync("packages/code-scene/src/layout.ts", "utf-8");
    expect(src).toContain("yMin: 458");
    expect(src).toContain("yMax: 602");
    expect(src).toContain("MARGIN = 96");
    expect(src).toContain("CONTENT_TOP = -816");
  });
});
