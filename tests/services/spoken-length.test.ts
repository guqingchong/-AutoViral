import { describe, it, expect } from "vitest";
import { spokenLength, estimateSpeechSeconds } from "../../src/services/spoken-length.js";

// 朗读字符口径 v1(2026-09-10 定稿,与 trend-research/content-planning skill 同步):
// 汉字=1;数字逐位展开每位=1,小数点=1(读"点");%=3(读"百分之");
// 拉丁字母每个=1;标点/空白/〔画面角标〕不计。
describe("spoken-length 朗读字符口径", () => {
  it("纯汉字逐字计", () => {
    expect(spokenLength("土地财政难以为继")).toBe(8);
  });

  it("数字逐位展开:41518=5,2026=4", () => {
    expect(spokenLength("41518")).toBe(5);
    expect(spokenLength("2026年")).toBe(5); // 2026 + 年
  });

  it("小数点读'点'计 1:14.7=4", () => {
    expect(spokenLength("14.7")).toBe(4);
  });

  it("百分号读'百分之'计 3:14.7%=7", () => {
    expect(spokenLength("14.7%")).toBe(7);
    expect(spokenLength("下降14.7%")).toBe(2 + 4 + 3);
  });

  it("全角数字与％同样展开", () => {
    expect(spokenLength("１４.７％")).toBe(7);
  });

  it("拉丁字母逐个计:REITs=5,AI=2", () => {
    expect(spokenLength("REITs")).toBe(5);
    expect(spokenLength("AI")).toBe(2);
  });

  it("标点与空白不计", () => {
    expect(spokenLength("先看一组数。")).toBe(5);
    expect(spokenLength("hello world")).toBe(10);
  });

  it("〔画面角标〕内容剔除不朗读", () => {
    expect(spokenLength("收入下降〔来源：财政部国库司〕明显")).toBe(4 + 2);
  });

  it("组合场景:41518亿元=7", () => {
    expect(spokenLength("41518亿元")).toBe(5 + 2);
  });

  it("时长估算:朗读字符 ÷ charsPerSec", () => {
    expect(estimateSpeechSeconds("土地财政难以为继", 4)).toBe(2);
    expect(estimateSpeechSeconds("土地财政难以为继")).toBeCloseTo(8 / 4.5, 5);
  });
});
