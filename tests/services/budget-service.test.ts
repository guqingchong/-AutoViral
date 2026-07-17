import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import type { DbWork } from "../../src/db/types.js";
import { getBudgetStatus, checkBeforeGeneration } from "../../src/services/budget-service.js";

function makeWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: "w_budget_" + Math.random().toString(36).slice(2, 10),
    title: "Budget Test",
    type: "short-video",
    status: "draft",
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("budget-service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("reports zero spend on empty db", () => {
    const status = getBudgetStatus();
    expect(status.spentYuan).toBe(0);
    expect(status.status).toBe("normal");
    expect(status.monthlyBudgetYuan).toBeGreaterThan(0);
  });

  it("aggregates actual_cost across works", () => {
    createWork(makeWork({ actual_cost: 100 }), []);
    createWork(makeWork({ actual_cost: 50.5 }), []);
    const status = getBudgetStatus();
    expect(status.spentYuan).toBeCloseTo(150.5, 2);
    expect(status.breakdown.works).toBeCloseTo(150.5, 2);
  });

  it("blocks generation when monthly budget exceeded", () => {
    createWork(makeWork({ actual_cost: 100000 }), []);
    const check = checkBeforeGeneration(0);
    expect(check.allowed).toBe(false);
    expect(check.status.status).toBe("exceeded");
  });

  it("allows generation within budget", () => {
    createWork(makeWork({ actual_cost: 100 }), []);
    const check = checkBeforeGeneration(50);
    expect(check.allowed).toBe(true);
  });
});