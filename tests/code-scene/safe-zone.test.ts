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

  it("design-tokens.css 五套主题齐备且变量完整", () => {
    const css = readFileSync("packages/code-scene/src/design-tokens.css", "utf-8");
    const themes = ["finance_dark", "warm_gold", "ink_green", "minimal_light", "magazine_light"];
    const vars = ["--bg:", "--bg-grid:", "--accent:", "--accent-2:", "--text:", "--text-sub:",
      "--shadow-lg:", "--radius-card:", "--ease-out:", "--font-display:", "--safe-zone-h: 144px"];
    for (const t of themes) {
      expect(css, `缺主题 ${t}`).toContain(`[data-theme="${t}"]`);
    }
    for (const v of vars) {
      for (const t of themes) {
        const block = css.split(`[data-theme="${t}"]`)[1]?.split("}")[0] ?? "";
        expect(block, `主题 ${t} 缺变量 ${v}`).toContain(v);
      }
    }
  });
});
