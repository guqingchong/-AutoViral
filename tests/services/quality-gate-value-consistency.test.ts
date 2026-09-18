import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertValueConsistency } from "../../src/services/quality-gate.js";

// 2026-09-11(assets 复盘改进点 2):数值一致性机器校验——固化自
// w_20260910_1758_479 手搓 check-values.py,拦截"旁白 4万亿 vs 画面 4.4万亿"。
describe("assertValueConsistency 数值一致性", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-value-"));
    mkdirSync(join(workDir, "research"), { recursive: true });
    mkdirSync(join(workDir, "assets"), { recursive: true });
    writeFileSync(join(workDir, "research", "article.json"), JSON.stringify({
      facts: [
        { text: "2024 年全国土地出让收入 4 万亿元,同比下降 14.7%" },
        { text: "某市国资平台负债 41518 亿元" },
      ],
    }));
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function writeScript(narrations: string[]) {
    writeFileSync(join(workDir, "assets", "script.json"), JSON.stringify({
      scenes: narrations.map((n, idx) => ({ i: idx + 1, source_section: `sec-${idx + 1}`, narration: n })),
    }));
  }

  it("旁白数字在权威数值表内 → 通过", () => {
    writeScript(["土地出让收入 4 万亿元,同比下降 14.7%。", "负债 41518 亿元。"]);
    expect(assertValueConsistency(workDir)).toEqual([]);
  });

  it("旁白数字超出权威数值表 → 拦(4.4万亿 vs facts 4万亿)", () => {
    writeScript(["土地出让收入 4.4 万亿元。"]);
    const issues = assertValueConsistency(workDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("narration_value_not_in_facts");
    expect(issues[0].detail).toContain("4.4");
  });

  it("年份豁免,裸数字(序数)不查", () => {
    writeScript(["2025 年出台的 3 项新政改变了格局。"]);
    expect(assertValueConsistency(workDir)).toEqual([]);
  });

  it("全角数字与千分位归一化", () => {
    writeScript(["负债 ４１,５１８ 亿元。"]);
    expect(assertValueConsistency(workDir)).toEqual([]);
  });

  it("数值卡屏上数字与旁白不一致 → 拦(事故原型)", () => {
    writeScript(["土地出让收入 4 万亿元。"]);
    writeFileSync(join(workDir, "assets", "render-specs.json"), JSON.stringify({
      cards: [{ shot: 1, file: "images/chart-01.png", on_screen_value: "4.4 万亿元 同比 -14.7%", caption: "土地出让收入" }],
    }));
    const issues = assertValueConsistency(workDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("screen_value_mismatch");
  });

  it("数值卡屏上数字 ⊆ 旁白 → 通过;年份标注豁免", () => {
    writeScript(["土地出让收入 4 万亿元,同比下降 14.7%。"]);
    writeFileSync(join(workDir, "assets", "render-specs.json"), JSON.stringify({
      cards: [{ shot: 1, file: "images/chart-01.png", on_screen_value: "4 万亿元 同比 -14.7%(2024 年)", caption: "来源:财政部" }],
    }));
    expect(assertValueConsistency(workDir)).toEqual([]);
  });

  it("产物缺失自动跳过(无 script/render-specs 不报错)", () => {
    rmSync(join(workDir, "assets", "script.json"), { force: true });
    expect(assertValueConsistency(workDir)).toEqual([]);
  });
});
