import { describe, it, expect } from "vitest";
import { wrapSemantic, buildAss } from "../../src/services/subtitle-gen.js";
import { measureAssSubtitles, assertScriptContract } from "../../src/services/quality-gate.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 2026-09-11 三问题复盘:字幕硬切截断("20|25")/"（无旁白）"被 TTS 照读。
describe("wrapSemantic 语义断行", () => {
  it("数字原子不拆:2025 永不腰斩(事故原型)", () => {
    const lines = wrapSemantic("先看一组数。2025 年，全国国有土地使用权出让收入。", 15);
    expect(lines.join("")).toContain("2025");
    for (const l of lines) {
      expect([...l].length).toBeLessThanOrEqual(15);
      expect(/^[0-9]/.test(l) && /[0-9]$/.test(lines[lines.indexOf(l) - 1] ?? "")).toBe(false);
    }
    // 数字完整落在某一行内
    expect(lines.some((l) => l.includes("2025"))).toBe(true);
  });

  it("英文单词原子不拆", () => {
    const lines = wrapSemantic("REITs 和 PPP 模式正在重构现金流。", 8);
    expect(lines.some((l) => l.includes("REITs"))).toBe(true);
    expect(lines.some((l) => l.includes("PPP"))).toBe(true);
    expect(lines.join("").replace(/\s/g, "")).toBe("REITs和PPP模式正在重构现金流。");
  });

  it("标点不悬行首(闭标点贴前行)", () => {
    const lines = wrapSemantic("土地财政的旧地图，已经找不到路了。", 8);
    for (const l of lines.slice(1)) {
      expect(/^[，。、；：？！）】」]/.test(l)).toBe(false);
    }
  });

  it("41518 亿元类长数字完整落行", () => {
    const lines = wrapSemantic("出让收入 41518 亿元，同比下降 14.7%。", 15);
    expect(lines.join("")).toContain("41518");
    expect(lines.some((l) => l.includes("41518"))).toBe(true);
    expect(lines.some((l) => l.includes("14.7"))).toBe(true);
  });
});

describe("buildAss karaoke 生成", () => {
  it("生成合法 ass:\kf 均布 + \\N 语义换行 + 门禁测量零违规", () => {
    const ass = buildAss([
      { text: "先看一组数。2025 年，全国国有土地使用权出让收入 41518 亿元。", start: 0.5, end: 6.5 },
      { text: "钱有，但合规边界不会松。", start: 7.0, end: 9.8 },
    ]);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:06.50");
    expect(ass).toContain("{\\kf");
    expect(ass).toContain("\\N");
    const m = measureAssSubtitles(ass);
    expect(m.violations).toEqual([]); // 生成物自证过门禁
    expect(m.entries).toBe(2);
  });

  it("空文本(无旁白镜头)不产生字幕条(镜50 事故)", () => {
    const ass = buildAss([
      { text: "有旁白的一句。", start: 0, end: 2 },
      { text: "", start: 2, end: 4.5 },
    ]);
    expect(measureAssSubtitles(ass).entries).toBe(1);
    expect(ass).not.toContain("无旁白");
  });
});

describe("占位文字拦截(门禁)", () => {
  it("跨行腰斩检测不误报:「60%」结尾接新数字是两个独立数字", () => {
    const ass = `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,占比超 60%。\n` +
      `Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,2026 年新规落地。\n`;
    expect(measureAssSubtitles(ass).violations).toEqual([]);
  });

  it("跨行腰斩数字 → 拦(20|25 事故原型)", () => {
    const ass = `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,先看一组数。20\n` +
      `Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,25 年，全国国有\n`;
    expect(measureAssSubtitles(ass).violations.some((v) => v.includes("腰斩"))).toBe(true);
  });

  it("ass 中（无旁白）→ 违规", () => {
    const ass = `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,（无旁白）\n`;
    expect(measureAssSubtitles(ass).violations.some((v) => v.includes("占位文字"))).toBe(true);
  });

  it("script.json narration=(无旁白) → 拦", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-noph-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "script.json"), JSON.stringify({
      scenes: [
        { i: 1, source_section: "sec-1", narration: "正常旁白。" },
        { i: 2, source_section: "sec-2", narration: "（无旁白）", duration_s: 2.5 },
      ],
    }));
    const issues = assertScriptContract(dir);
    expect(issues.some((i) => i.key === "script_narration_placeholder")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("narration 留空是合法的无旁白表达", () => {
    const dir = mkdtempSync(join(tmpdir(), "av-noph-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "script.json"), JSON.stringify({
      scenes: [{ i: 1, source_section: "sec-1", narration: "" }],
    }));
    const issues = assertScriptContract(dir);
    expect(issues.filter((i) => i.key === "script_narration_placeholder")).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
