import { describe, it, expect } from "vitest";
import { renderDataCard } from "../../src/services/data-card.js";

// 只测纯函数部分(图表类型选择与参数校验),不真渲染(需要浏览器)
// renderDataCard 在校验失败时同步抛错,可用 rejects 断言

describe("renderDataCard 参数校验", () => {
  it("空数据报错", async () => {
    await expect(renderDataCard({ data: [] })).rejects.toThrow("非空数组");
  });
  it("非法元素报错", async () => {
    await expect(renderDataCard({ data: [{ label: "a", value: NaN }] })).rejects.toThrow("label: string");
  });
});
