/**
 * Budget control service (PRD §4.3.6).
 *
 * Aggregates actual third-party service costs, tracks a monthly budget cap,
 * and enforces a pre-generation gate so non-essential AI calls are paused once
 * the monthly budget is exhausted.
 */

import { getDb } from "../db/connection.js";
import { getConfig, saveConfig } from "../config.js";

export type BudgetStatusLevel = "normal" | "warning" | "exceeded";

export interface BudgetBreakdown {
  digitalHuman: number;
  works: number;
}

export interface BudgetStatus {
  yearMonth: string;
  monthlyBudgetYuan: number;
  dailyBudgetYuan: number;
  spentTodayYuan: number;
  spentYuan: number;
  remainingYuan: number;
  usagePercent: number;
  status: BudgetStatusLevel;
  warningThresholdPercent: number;
  breakdown: BudgetBreakdown;
}

export interface PreCheckResult {
  allowed: boolean;
  reason?: string;
  status: BudgetStatus;
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function sumColumn(table: string, column: string, datePrefix: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COALESCE(SUM(CAST(${column} AS REAL)), 0) AS total FROM ${table} WHERE strftime('%Y-%m', created_at) = ?`)
    .get(datePrefix) as { total: number } | undefined;
  return row?.total ?? 0;
}

function sumColumnToday(table: string, column: string, datePrefix: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COALESCE(SUM(CAST(${column} AS REAL)), 0) AS total FROM ${table} WHERE strftime('%Y-%m-%d', created_at) = ?`)
    .get(datePrefix) as { total: number } | undefined;
  return row?.total ?? 0;
}

function computeMonthlySpend(yearMonth: string): { digitalHuman: number; works: number; total: number } {
  const works = sumColumn("works", "actual_cost", yearMonth);
  const digitalHuman = sumColumn("digital_human_jobs", "actual_cost", yearMonth);
  return { digitalHuman, works, total: works + digitalHuman };
}

function computeDailySpend(date: string): number {
  return sumColumnToday("works", "actual_cost", date) + sumColumnToday("digital_human_jobs", "actual_cost", date);
}

export function getMonthlyBudget(): number {
  return getConfig().budget?.monthlyLimitYuan ?? 2500;
}

export function getDailyBudget(): number {
  return getConfig().budget?.dailyLimitYuan ?? 200;
}

export function getWarningThreshold(): number {
  return getConfig().budget?.warningThresholdPercent ?? 80;
}

export async function setBudgetLimits(limits: {
  monthlyLimitYuan?: number;
  dailyLimitYuan?: number;
  warningThresholdPercent?: number;
}): Promise<void> {
  const config = getConfig();
  const current = config.budget ?? {
    monthlyLimitYuan: 2500,
    dailyLimitYuan: 200,
    warningThresholdPercent: 80,
  };
  config.budget = {
    monthlyLimitYuan: limits.monthlyLimitYuan ?? current.monthlyLimitYuan,
    dailyLimitYuan: limits.dailyLimitYuan ?? current.dailyLimitYuan,
    warningThresholdPercent: limits.warningThresholdPercent ?? current.warningThresholdPercent,
  };
  await saveConfig(config);
}

export function getBudgetStatus(yearMonth?: string): BudgetStatus {
  const ym = yearMonth ?? currentYearMonth();
  const monthlyBudget = getMonthlyBudget();
  const dailyBudget = getDailyBudget();
  const warning = getWarningThreshold();
  const { digitalHuman, works, total } = computeMonthlySpend(ym);
  const spentToday = computeDailySpend(todayISO());
  const remaining = Math.max(0, monthlyBudget - total);
  const usagePercent = monthlyBudget > 0 ? (total / monthlyBudget) * 100 : 0;

  let status: BudgetStatusLevel = "normal";
  if (monthlyBudget > 0 && total >= monthlyBudget) status = "exceeded";
  else if (usagePercent >= warning) status = "warning";

  return {
    yearMonth: ym,
    monthlyBudgetYuan: monthlyBudget,
    dailyBudgetYuan: dailyBudget,
    spentTodayYuan: spentToday,
    spentYuan: total,
    remainingYuan: remaining,
    usagePercent: Math.round(usagePercent * 100) / 100,
    status,
    warningThresholdPercent: warning,
    breakdown: { digitalHuman, works },
  };
}

/**
 * Pre-generation gate. Returns whether a new AI generation with the given
 * estimated cost is allowed under the current budget. When the monthly budget
 * is exhausted (or would be exceeded), non-essential generation is blocked.
 */
export function checkBeforeGeneration(estimatedCostYuan: number): PreCheckResult {
  const status = getBudgetStatus();
  if (status.monthlyBudgetYuan <= 0) return { allowed: true, status };

  if (status.spentYuan + estimatedCostYuan > status.monthlyBudgetYuan) {
    return {
      allowed: false,
      reason: `月度预算不足：已用 ${status.spentYuan.toFixed(2)} 元 + 预估 ${estimatedCostYuan.toFixed(2)} 元 > 预算 ${status.monthlyBudgetYuan.toFixed(2)} 元`,
      status,
    };
  }
  return { allowed: true, status };
}

/**
 * Record an actual cost against a work. Convenience wrapper that updates the
 * work's actual_cost (the repo also supports this directly).
 */
export function assertWithinBudget(estimatedCostYuan: number): void {
  const check = checkBeforeGeneration(estimatedCostYuan);
  if (!check.allowed) {
    throw new Error(check.reason ?? "月度预算已耗尽，暂停非必要 AI 调用");
  }
}