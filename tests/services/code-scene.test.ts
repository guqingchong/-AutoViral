import { describe, it, expect } from "vitest";
import { validateCodeSceneInput } from "../../src/services/code-scene.js";

const base = { workId: "w_test", filename: "demo", template: { name: "flow-steps", params: { title: "三条标准", steps: [{ title: "隐债清零" }, { title: "剥离职能" }] } } };

describe("validateCodeSceneInput", () => {
  it("合法 flow-steps 输入通过", () => {
    expect(validateCodeSceneInput(base as any)).toEqual([]);
  });
  it("未知模板名报错", () => {
    const errs = validateCodeSceneInput({ ...base, template: { name: "hologram", params: {} } } as any);
    expect(errs.join()).toContain("未知场景模板");
  });
  it("template 与 customScene 二选一", () => {
    expect(validateCodeSceneInput({ workId: "w", filename: "f" } as any).join()).toContain("二选一");
    expect(validateCodeSceneInput({ ...base, customScene: "x" } as any).join()).toContain("二选一");
  });
  it("flow-steps 步数越界报错", () => {
    const tooMany = { ...base, template: { name: "flow-steps", params: { title: "t", steps: Array.from({ length: 6 }, (_, i) => ({ title: `s${i}` })) } } };
    expect(validateCodeSceneInput(tooMany as any).join()).toContain("2-5");
  });
  it("标题超长报错", () => {
    const long = { ...base, template: { name: "flow-steps", params: { title: "这是一个超过十二个字的超长标题啊", steps: [{ title: "a" }, { title: "b" }] } } };
    expect(validateCodeSceneInput(long as any).join()).toContain("≤12");
  });
  it("duration 超出 1-30 报错", () => {
    expect(validateCodeSceneInput({ ...base, duration: 60 } as any).join()).toContain("duration");
  });
  it("非法主题报错", () => {
    expect(validateCodeSceneInput({ ...base, theme: "neon" } as any).join()).toContain("theme");
  });
  it("structure-growth 分支数 2-4", () => {
    const bad = { workId: "w", filename: "f", template: { name: "structure-growth", params: { title: "t", center: "c", branches: [{ text: "a", label: "b" }] } } };
    expect(validateCodeSceneInput(bad as any).join()).toContain("2-4");
  });
});
