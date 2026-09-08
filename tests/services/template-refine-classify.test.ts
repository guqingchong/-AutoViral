import { describe, it, expect } from "vitest";
import { classifyRefineInstruction } from "../../src/services/template-refine.js";

// 2026-09-07 指令分流(架构改造层3):参数微调/结构新增/整体重做 走不同通道
describe("classifyRefineInstruction 再加工指令分流", () => {
  it("参数微调类 → param", () => {
    expect(classifyRefineInstruction("配色改成墨绿系")).toBe("param");
    expect(classifyRefineInstruction("标题字号加大一点")).toBe("param");
    expect(classifyRefineInstruction("转场全部换成淡入淡出")).toBe("param");
  });

  it("结构新增类 → structural", () => {
    expect(classifyRefineInstruction("封面底板改成太空飞船舱门")).toBe("structural");
    expect(classifyRefineInstruction("正文底板改为飞船操作台")).toBe("structural");
    expect(classifyRefineInstruction("字体立体发光,补副标题占位")).toBe("structural");
    expect(classifyRefineInstruction("新增一个数据卡片模块")).toBe("structural");
  });

  it("整体重做类 → redo", () => {
    expect(classifyRefineInstruction("全部推翻重做")).toBe("redo");
    expect(classifyRefineInstruction("风格全换,重新生成一版")).toBe("redo");
  });
});
