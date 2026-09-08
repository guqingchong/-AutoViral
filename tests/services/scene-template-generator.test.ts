/**
 * 镜头模板目录/注册表 + 生成器静态检查单测(2026-09-02)。
 *
 * 最有价值的一条契约:目录里每款模板的 sample 必须通过 validateCodeSceneInput——
 * 否则模板库页「▶ 预览样片」会直接 400。此处用纯校验防回归,不跑真实渲染。
 */
import { describe, it, expect } from "vitest";
import {
  listSceneTemplates,
  findSceneTemplate,
  isWebTemplate,
  validateCodeSceneInput,
  WEB_TEMPLATES,
} from "../../src/services/code-scene.js";
import {
  staticCheckHtml,
  normalizeSceneName,
  buildSceneTemplatePrompt,
} from "../../src/services/scene-template-generator.js";

describe("镜头模板目录(listSceneTemplates)", () => {
  it("包含竖屏 9 款 + 横屏衍生 9 款 + 横屏原生 2 款", () => {
    const names = listSceneTemplates().map((t) => t.name);
    for (const base of Object.keys(WEB_TEMPLATES)) expect(names).toContain(base);
    expect(names).toContain("cover-title-wide");
    expect(names).toContain("keynote-leather");
    // 无重复名(注册表与内建冲突时过滤语义由 registerSceneTemplate 保证)
    expect(new Set(names).size).toBe(names.length);
  });

  it("每款模板的 sample 都能通过渲染入参校验(预览按钮不死)", () => {
    for (const tpl of listSceneTemplates()) {
      const errors = validateCodeSceneInput({
        workId: "_scene_preview",
        filename: `prev_${tpl.name}`,
        template: { name: tpl.name, params: { ...tpl.sample } },
        duration: 4,
      });
      expect(errors, `${tpl.name} sample 校验失败: ${errors.join("; ")}`).toEqual([]);
    }
  });

  it("findSceneTemplate/isWebTemplate 判定", () => {
    expect(findSceneTemplate("flow-steps")?.label).toContain("流程");
    expect(findSceneTemplate("flow-steps-wide")?.sample).toEqual(findSceneTemplate("flow-steps")?.sample);
    expect(findSceneTemplate("not-exist")).toBeUndefined();
    expect(isWebTemplate("bar-compare-wide")).toBe(true);
    expect(isWebTemplate("keynote-leather")).toBe(false); // Revideo 整片,不走 web 支路
  });
});

describe("scene-template-generator 静态检查", () => {
  const okHtml = `<!DOCTYPE html><html><head><style id="theme-vars"></style></head><body><div id="t"></div>
<script>(function(){document.getElementById("theme-vars").textContent=window.__THEME_CSS__||"";var P=window.__PARAMS__||{};document.getElementById("t").animate([{opacity:0},{opacity:1}],{duration:500,fill:"both"});window.__seek=function(t){};window.__seek(0);})();</script></body></html>`;

  it("合法骨架通过", () => {
    expect(staticCheckHtml(okHtml)).toEqual([]);
  });

  it("拦截契约缺失与禁止模式", () => {
    expect(staticCheckHtml("<div>not html</div>").length).toBeGreaterThan(0);
    expect(staticCheckHtml(okHtml.replace('id="theme-vars"', 'id="x"')).join()).toContain("theme-vars");
    expect(staticCheckHtml(okHtml.replace("window.__seek=function(t){};", "")).join()).toContain("__seek");
    expect(staticCheckHtml(okHtml + "<script src='https://cdn.x.com/a.js'></script>").join()).toContain("禁止");
    expect(staticCheckHtml(okHtml.replace(".animate(", ".notAnimate(")).join()).toContain("WAAPI");
    expect(staticCheckHtml(okHtml + "<script>setTimeout(()=>{},1)</script>").join()).toContain("setTimeout");
  });

  it("模板名规范化:横屏强制 -wide,竖屏剥离 -wide", () => {
    expect(normalizeSceneName("Growth Tree", "portrait")).toBe("growth-tree");
    expect(normalizeSceneName("growth-tree", "landscape")).toBe("growth-tree-wide");
    expect(normalizeSceneName("growth-tree-wide", "portrait")).toBe("growth-tree");
    expect(normalizeSceneName("A".repeat(40), "landscape")).toMatch(/^a{24}-wide$/);
  });

  it("生成 prompt 携带关键契约(防漂移)", () => {
    const p = buildSceneTemplatePrompt({ style: "测试", orientation: "portrait" });
    for (const kw of ["__THEME_CSS__", "__seek", "fill:'both'", "1418", "sampleParams", "-wide"]) {
      expect(p).toContain(kw);
    }
    const pw = buildSceneTemplatePrompt({ style: "测试", orientation: "landscape" });
    expect(pw).toContain("1920×1080");
    expect(pw).toContain("880");
  });
});
