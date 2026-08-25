import { describe, it, expect } from "vitest";
import { buildCodeTemplatePrompt, staticCheckTsx } from "../../src/services/code-template-generator.js";

describe("buildCodeTemplatePrompt(设计系统约束)", () => {
  it("包含全部硬性纪律:参数契约/铁律/白名单/画幅", () => {
    const p = buildCodeTemplatePrompt({ style: "赛博朋克", orientation: "landscape" });
    expect(p).toContain("赛博朋克");
    expect(p).toContain("1920×1080");
    expect(p).toContain("export default function");
    expect(p).toContain("while(true)");
    expect(p).toContain("params.duration");
    expect(p).toContain("@revideo/2d");
    expect(p).toContain("FONT");
    expect(p).toContain('"tsx"');
  });
  it("竖屏默认 1080×1920,数字人窗口按需出现", () => {
    const p = buildCodeTemplatePrompt({ style: "极简" });
    expect(p).toContain("1080×1920");
    expect(p).not.toContain("macOS 三灯");
    const dh = buildCodeTemplatePrompt({ style: "极简", withDigitalHuman: true });
    expect(dh).toContain("macOS 三灯");
  });
});

describe("staticCheckTsx(渲染前静态拦截)", () => {
  const good = `
import { makeScene2D, Rect } from "@revideo/2d";
import { createRef } from "@revideo/core";
export default function(params: any) {
  return makeScene2D("custom", function* (view) {
    view.add(<Rect width={100} height={100} />);
  });
}`;
  it("合法代码通过", () => {
    expect(staticCheckTsx(good)).toEqual([]);
  });
  it("缺工厂导出/缺场景被拦", () => {
    expect(staticCheckTsx("const x = 1;").join()).toContain("export default function");
    expect(staticCheckTsx("export default function() { return 1; }").join()).toContain("makeScene2D");
  });
  it("while(true) 无限循环被拦(渲染器铁律)", () => {
    const bad = good + "\nwhile (true) { yield; }";
    expect(staticCheckTsx(bad).join()).toContain("while(true)");
  });
  it("白名单外 import 被拦", () => {
    const bad = good.replace('from "@revideo/2d"', 'from "lodash"');
    expect(staticCheckTsx(bad).join()).toContain("白名单外");
  });
  it("fetch/DOM/定时器/Math.random 被拦", () => {
    expect(staticCheckTsx(good + "\nfetch('/api')").join()).toContain("确定可重现");
    expect(staticCheckTsx(good + "\ndocument.body").join()).toContain("确定可重现");
    expect(staticCheckTsx(good + "\nMath.random()").join()).toContain("确定可重现");
  });
});

describe("buildCodeTemplatePrompt(brief 注入)", () => {
  const brief = {
    styleSummary: "深色底赛博霓虹",
    palette: [{ hex: "#0a0e17", role: "背景" }, { hex: "#00e5ff", role: "强调" }],
    layout: [{ region: "标题区", content: "title", position: "居中偏上" }],
    elements: ["青色辉光", "品红网格"],
    motion: { entrance: "标题 0s → 主视觉 0.24s", loop: "辉光 3s 呼吸" },
    sourceText: "赛博朋克",
  };
  it("有 brief 时:按稿施工措辞 + 白名单 + brief 内容注入", () => {
    const p = buildCodeTemplatePrompt({ style: "赛博朋克", orientation: "portrait", brief });
    expect(p).toContain("严格实现以下已确认设计稿");
    expect(p).toContain("禁止添加稿外元素");
    expect(p).toContain("#00e5ff");
    expect(p).toContain("品红网格");
    // 既有纪律不丢失
    expect(p).toContain("export default function");
    expect(p).toContain("while(true)");
  });
  it("无 brief 时保持原样(向后兼容)", () => {
    const p = buildCodeTemplatePrompt({ style: "赛博朋克", orientation: "portrait" });
    expect(p).toContain("设计需求:赛博朋克");
    expect(p).not.toContain("严格实现以下已确认设计稿");
  });
});
