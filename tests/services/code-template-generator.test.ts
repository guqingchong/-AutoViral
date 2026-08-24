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
