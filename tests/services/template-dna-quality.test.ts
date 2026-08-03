import { describe, it, expect } from "vitest";
import { checkTemplateQuality, contrastRatio } from "../../src/services/template-quality.js";
import { buildElementsPrompt, GOLDEN_EXAMPLE, DEFAULT_ELEMENTS } from "../../src/services/template-dna.js";

describe("template-quality", () => {
  const cleanTemplate = {
    canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0B1B33" },
    variables: [{ name: "topic", type: "text", default: "主题", label: "主题" }],
    layers: [
      { id: "bg", type: "shape", fill: "#0B1B33", start: 0, duration: 10, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
      { id: "title", type: "text", content: "{{topic}}", fontSize: 68, color: "#FFFFFF", align: "left", start: 0.2, duration: 9.8, position: { x: 70, y: 160 } },
      { id: "body", type: "text", content: "正文", fontSize: 28, color: "#9FB4D0", align: "left", start: 0.5, duration: 9.5, position: { x: 70, y: 300 } },
    ],
  };

  it("passes a well-formed template", () => {
    expect(checkTemplateQuality(cleanTemplate)).toEqual([]);
  });

  it("flags non-hex colors", () => {
    const t = structuredClone(cleanTemplate);
    t.layers[1]!.color = "rgba(255,255,255,0.8)";
    const issues = checkTemplateQuality(t);
    expect(issues.some((i) => i.rule === "color-format")).toBe(true);
  });

  it("flags layers outside canvas bounds", () => {
    const t = structuredClone(cleanTemplate);
    t.layers.push({ id: "bad", type: "shape", fill: "#16283F", start: 0, duration: 10, position: { x: 900, y: 100 }, size: { width: 400, height: 100 } });
    const issues = checkTemplateQuality(t);
    expect(issues.some((i) => i.rule === "bounds")).toBe(true);
  });

  it("flags low-contrast text against its underlying shape", () => {
    const t = structuredClone(cleanTemplate);
    // 文字落在深色卡片上但用了深色文字
    t.layers.push({ id: "card", type: "shape", fill: "#16283F", start: 0, duration: 10, position: { x: 70, y: 500 }, size: { width: 940, height: 200 } });
    t.layers.push({ id: "darktext", type: "text", content: "看不清", fontSize: 30, color: "#1A2A40", align: "left", start: 0, duration: 10, position: { x: 110, y: 540 } });
    const issues = checkTemplateQuality(t);
    expect(issues.some((i) => i.rule === "contrast")).toBe(true);
  });

  it("flags collapsed font hierarchy", () => {
    const t = structuredClone(cleanTemplate);
    t.layers[1]!.fontSize = 32; // 改后主标题仅 32px
    // 凑满 3 档字号：32 / 30 / 28，极差 < 1.5 倍
    t.layers.push({ id: "sub", type: "text", content: "副标题", fontSize: 30, color: "#9FB4D0", align: "left", start: 0, duration: 10, position: { x: 70, y: 250 } });
    const issues = checkTemplateQuality(t);
    expect(issues.some((i) => i.rule === "font-hierarchy")).toBe(true);
  });

  it("flags dangling variable references", () => {
    const t = structuredClone(cleanTemplate);
    t.layers[1]!.content = "{{undefined_var}}";
    const issues = checkTemplateQuality(t);
    expect(issues.some((i) => i.rule === "variable-ref")).toBe(true);
  });

  it("contrastRatio: black on white = 21, same color = 1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 2);
  });

  it("golden example itself passes quality check", () => {
    expect(checkTemplateQuality(GOLDEN_EXAMPLE as never)).toEqual([]);
  });
});

describe("template-dna", () => {
  it("builds prompt from full element selection", () => {
    const prompt = buildElementsPrompt({
      contentForm: "knowledge",
      layout: "card_stack",
      palette: "ink_green",
      motion: "slide",
      decorations: ["accent_bar", "serial_number"],
      freeText: "要像 Apple 发布会",
    });
    expect(prompt).toContain("知识科普卡片");
    expect(prompt).toContain("卡片堆叠风");
    expect(prompt).toContain("#0C1F17");
    expect(prompt).toContain("滑入节奏");
    expect(prompt).toContain("顶部装饰条");
    expect(prompt).toContain("序号系统");
    expect(prompt).toContain("要像 Apple 发布会");
  });

  it("falls back to defaults when elements are empty", () => {
    const prompt = buildElementsPrompt({});
    expect(prompt).toContain(DEFAULT_ELEMENTS.contentForm === "knowledge" ? "知识科普卡片" : "");
    // 未选版式时要求多样性
    expect(prompt).toContain("版式必须明显不同");
  });

  it("freeText is marked highest priority", () => {
    const prompt = buildElementsPrompt({ freeText: "特殊要求" });
    expect(prompt).toContain("优先级最高");
  });
});
