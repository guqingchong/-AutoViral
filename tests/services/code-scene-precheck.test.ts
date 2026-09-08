import { describe, it, expect } from "vitest";
import { precheckTemplate } from "../../src/services/code-scene.js";

// B2 修复(2026-09-08):particles 三类计数取 max(sum 双重计数误杀);varCounts 收窄到 Count|Total|Num 结尾
describe("precheckTemplate 计数口径(B2)", () => {
  it("变量+循环同源写法(var techCount=120 + for i<120)不误杀", () => {
    const html = `<script>
      var techCount = 120;
      for (let i = 0; i < 120; i++) { drawDot(i); }
    </script>`;
    // 120 < 200 且无 shadowBlur 组合 → 放行(旧 sum=240 误杀)
    expect(precheckTemplate(html)).toBeNull();
  });

  it("真实 120 粒子 + shadowBlur 组合仍拦截", () => {
    const html = `<script>
      var techCount = 120;
      for (let i = 0; i < 120; i++) { ctx.shadowBlur = 18; drawDot(i); }
    </script>`;
    expect(precheckTemplate(html)).toMatch(/模板过重/);
  });

  it("200+ 单一大数组仍按 particles 拦截", () => {
    const html = `<script>const pts = new Array(300);</script>`;
    expect(precheckTemplate(html)).toMatch(/模板过重/);
  });

  it("number 等无关变量不计入(varCounts 收窄)", () => {
    const html = `<script>
      const number = 500;
      const renum = 300;
      for (let i = 0; i < 10; i++) { tick(i); }
    </script>`;
    expect(precheckTemplate(html)).toBeNull();
  });
});
