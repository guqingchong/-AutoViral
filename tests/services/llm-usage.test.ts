/**
 * P3-T2 llm-usage 记账与熔断测试（2026-08-18）。
 * 用 AUTOVIRAL_DATA_DIR 指向临时目录隔离真实库。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AUTOVIRAL_DATA_DIR = mkdtempSync(join(tmpdir(), "llm-usage-test-"));

import { migrate } from "../../src/db/migrate.js";
import { recordUsage, getDailyCostYuan, estimateCostYuan, enforceDailyBudget, isPeakHours } from "../../src/services/llm-usage.js";
import type { Config } from "../../src/config.js";

const configWithPrice = {
  llm: {
    priceTable: { "deepseek:deepseek-v4-flash": { input: 2, output: 8, cacheRead: 0.2 } },
  },
  budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
} as unknown as Config;

beforeAll(() => migrate());

describe("llm-usage", () => {
  it("按价目表估算成本:命中部分只收缓存价,不再双重计费(2026-09-18 根因修复)", () => {
    // 自配平价目(无 offPeak)→ 全时段同价;input 1M 中 0.5M 缓存命中
    const cost = estimateCostYuan(configWithPrice, {
      provider: "deepseek", model: "deepseek-v4-flash",
      inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000,
    });
    // 正确口径:未命中 0.5M×2 + 输出 0.1M×8 + 命中 0.5M×0.2 = 1.9
    // (旧 bug 口径:input 全量 1M×2 + 输出 + 命中另加 = 2.9,命中部分被收两次)
    expect(cost).toBeCloseTo(1.9, 6);
  });

  it("全部缓存命中时只收缓存价", () => {
    const cost = estimateCostYuan(configWithPrice, {
      provider: "deepseek", model: "deepseek-v4-flash",
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.2, 6);
  });

  it("峰谷计价:DeepSeek 官方高峰=北京时间周一至五 9-12/14-18 点", () => {
    // 2026-09-18 是周五。北京时间 10:00 = UTC 02:00(高峰);北京时间 20:00 = UTC 12:00(空闲);周六全天空闲
    expect(isPeakHours(new Date(Date.UTC(2026, 8, 18, 2, 0)))).toBe(true);
    expect(isPeakHours(new Date(Date.UTC(2026, 8, 18, 6, 0)))).toBe(true);  // 北京 14:00
    expect(isPeakHours(new Date(Date.UTC(2026, 8, 18, 12, 0)))).toBe(false); // 北京 20:00
    expect(isPeakHours(new Date(Date.UTC(2026, 8, 19, 2, 0)))).toBe(false);  // 周六
  });

  it("峰谷计价:内置刊例空闲时段半价", () => {
    const noCfg = { llm: {} } as unknown as Config;
    const rec = { provider: "deepseek", model: "deepseek-flash", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
    const peak = estimateCostYuan(noCfg, rec, new Date(Date.UTC(2026, 8, 18, 2, 0)));
    const off = estimateCostYuan(noCfg, rec, new Date(Date.UTC(2026, 8, 18, 12, 0)));
    expect(peak).toBeCloseTo(2, 6);   // 高峰未命中 2 元/M
    expect(off).toBeCloseTo(1, 6);    // 空闲半价 1 元/M
  });

  it("无价目记 0 但仍落账", () => {
    recordUsage(configWithPrice, { provider: "unknown", model: "x", inputTokens: 100, outputTokens: 50 });
    recordUsage(configWithPrice, { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 1_000_000, outputTokens: 0, workId: "w1", stage: "plan" });
    expect(getDailyCostYuan()).toBeCloseTo(2, 6);
  });

  it("日累计未超上限不熔断", () => {
    let paused = 0;
    const hit = enforceDailyBudget(configWithPrice, () => { paused++; return paused; });
    expect(hit).toBe(false);
    expect(paused).toBe(0);
  });

  it("日累计超上限触发熔断并暂停队列", () => {
    const tight = {
      ...configWithPrice,
      budget: { ...configWithPrice.budget, dailyLimitYuan: 1 },
    } as Config;
    let paused = 0;
    const hit = enforceDailyBudget(tight, () => { paused += 3; return 3; });
    expect(hit).toBe(true);
    expect(paused).toBe(3);
  });
});
