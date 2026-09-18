import { describe, it, expect } from "vitest";
import { isTransientWorkerError } from "../../src/services/code-scene.js";

// 2026-09-11:瞬时渲染故障自动重试——navigation timeout 之外补
// "Target page, context or browser has been closed"(城市经营作品实测人工重渲才恢复)
describe("isTransientWorkerError 瞬时故障判定", () => {
  it("navigation timeout 可重试", () => {
    expect(isTransientWorkerError("渲染失败(exit 1): Error: Navigation timeout of 30000 ms exceeded")).toBe(true);
  });

  it("Target page closed 可重试(Playwright 标准报文)", () => {
    expect(isTransientWorkerError("渲染失败(exit 1): Error: Target page, context or browser has been closed")).toBe(true);
  });

  it("Target closed 简写变体可重试", () => {
    expect(isTransientWorkerError("Target closed")).toBe(true);
    expect(isTransientWorkerError("browser has been closed")).toBe(true);
  });

  it("参数/代码类错误不重试", () => {
    expect(isTransientWorkerError("渲染失败(exit 1): ReferenceError: techCount is not defined")).toBe(false);
    expect(isTransientWorkerError("渲染失败(exit 1): Error: spec JSON 解析失败")).toBe(false);
  });
});
