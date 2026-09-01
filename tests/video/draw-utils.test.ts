/**
 * draw-utils 单元测试：FFmpeg 滤镜安全工具
 * （源自 2026-07-17 模板渲染修复：rgba() 崩溃滤镜链 / 中文路径字体加载失败 / % 转义层级）
 */
import { describe, it, expect } from "vitest";
import {
  normalizeColorForFfmpeg,
  wrapTextLines,
  escapeDrawtext,
  escapeFilterPath,
} from "../../src/video/draw-utils.js";

describe("normalizeColorForFfmpeg", () => {
  it("converts #RRGGBB to 0x form", () => {
    expect(normalizeColorForFfmpeg("#4D8DFF")).toBe("0x4d8dff");
    expect(normalizeColorForFfmpeg("#FFF")).toBe("0xffffff");
  });

  it("converts rgb() to 0x form", () => {
    expect(normalizeColorForFfmpeg("rgb(255, 0, 0)")).toBe("0xff0000");
  });

  it("premultiplies rgba() against background into solid color", () => {
    const out = normalizeColorForFfmpeg("rgba(255,255,255,0.06)", "#0B1B33");
    // 预混合后必须是六位实色（滤镜链安全），且接近但略亮于背景
    expect(out).toMatch(/^0x[0-9a-f]{6}$/);
    expect(out).not.toBe("0x0b1b33");
  });

  it("keeps 8-digit 0x form when no background provided", () => {
    const out = normalizeColorForFfmpeg("rgba(255,255,255,0.5)");
    expect(out).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("passes through color names", () => {
    expect(normalizeColorForFfmpeg("white")).toBe("white");
  });

  it("falls back to white for undefined", () => {
    expect(normalizeColorForFfmpeg(undefined)).toBe("0xFFFFFF");
  });
});

describe("wrapTextLines", () => {
  it("wraps CJK text by estimated width", () => {
    const lines = wrapTextLines("头部厂商在上下文长度推理成本和多模态能力上密集更新行业格局加速洗牌", 28, 500);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.length * 28).toBeLessThanOrEqual(500 + 28);
    }
  });

  it("respects hard newlines", () => {
    expect(wrapTextLines("第一行\n第二行", 28, 9999)).toEqual(["第一行", "第二行"]);
  });

  it("returns single line when no maxWidth", () => {
    expect(wrapTextLines("不换行的文本内容", 28)).toEqual(["不换行的文本内容"]);
  });

  it("returns empty for empty text", () => {
    expect(wrapTextLines("", 28, 500)).toEqual([]);
  });

  it("避头: 标点不得出现在行首(宁可上一行略超宽)", () => {
    // maxUnits=5 → 第 6 字触发换行;构造第 6 字恰为句号
    const lines = wrapTextLines("一二三四五。六七八九十", 100, 500);
    for (const l of lines.slice(1)) {
      expect("，。、；：？！』」》".includes(l[0])).toBe(false);
    }
    expect(lines.join("")).toBe("一二三四五。六七八九十");
  });
});

describe("escapeDrawtext", () => {
  it("escapes % as \\\\% (double backslash for expansion layer)", () => {
    // % 必须转义为 \\%：filter 图解析层消耗一个反斜杠后，
    // drawtext text expansion 层才能看到 \%（实测 2026-07-17）
    expect(escapeDrawtext("47%")).toBe("47\\\\%");
  });

  it("escapes colon with single backslash", () => {
    expect(escapeDrawtext("增长: 100")).toBe("增长\\: 100");
  });

  it("escapes filter separators", () => {
    const out = escapeDrawtext("a,b;c[d]");
    expect(out).toContain("\\,");
    expect(out).toContain("\\;");
    expect(out).toContain("\\[");
    expect(out).toContain("\\]");
  });
});

describe("escapeFilterPath", () => {
  it("converts backslashes and escapes drive colon", () => {
    expect(escapeFilterPath("C:\\ProgramData\\AutoViral\\fonts\\a.otf")).toBe("C\\:/ProgramData/AutoViral/fonts/a.otf");
  });
});
