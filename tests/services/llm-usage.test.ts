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
import { recordUsage, getDailyCostYuan, estimateCostYuan, enforceDailyBudget } from "../../src/services/llm-usage.js";
import type { Config } from "../../src/config.js";

const configWithPrice = {
  llm: {
    priceTable: { "deepseek:deepseek-v4-flash": { input: 2, output: 8, cacheRead: 0.2 } },
  },
  budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
} as unknown as Config;

beforeAll(() => migrate());

describe("llm-usage", () => {
  it("按价目表估算成本(元/百万 tokens)", () => {
    const cost = estimateCostYuan(configWithPrice, {
      provider: "deepseek", model: "deepseek-v4-flash",
      inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000,
    });
    expect(cost).toBeCloseTo(2 + 0.8 + 0.1, 6);
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
