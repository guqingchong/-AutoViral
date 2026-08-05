import { describe, it, expect } from "vitest";
import { topicScore } from "../../src/services/trend-research.js";

describe("topicScore 综合评分", () => {
  it("热度权重最高（×2）", () => {
    const hot = topicScore({ heat: 5, opportunity: "红海", competition: "高" });
    const cold = topicScore({ heat: 1, opportunity: "金矿", competition: "低" });
    expect(hot).toBeGreaterThan(cold);
  });

  it("同热度下金矿 > 蓝海 > 红海", () => {
    const gold = topicScore({ heat: 3, opportunity: "金矿", competition: "中" });
    const blue = topicScore({ heat: 3, opportunity: "蓝海", competition: "中" });
    const red = topicScore({ heat: 3, opportunity: "红海", competition: "中" });
    expect(gold).toBeGreaterThan(blue);
    expect(blue).toBeGreaterThan(red);
  });

  it("同热度同机会下低竞争 > 高竞争", () => {
    const low = topicScore({ heat: 3, opportunity: "蓝海", competition: "低" });
    const high = topicScore({ heat: 3, opportunity: "蓝海", competition: "高" });
    expect(low).toBeGreaterThan(high);
  });

  it("异常输入不抛错（缺字段/字符串热度）", () => {
    expect(topicScore({})).toBe(0);
    expect(topicScore({ heat: "4" as unknown as number })).toBe(8);
  });
});
