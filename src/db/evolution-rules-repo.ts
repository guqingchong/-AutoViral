import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbEvolutionRule, DbRuleType } from "./types.js";

function rowToRule(row: Record<string, unknown>): DbEvolutionRule {
  return {
    id: row.id as number,
    rule_type: row.rule_type as DbRuleType,
    target_key: (row.target_key as string) || undefined,
    condition_json: fromJson(row.condition_json as string) as Record<string, unknown>,
    action: row.action as string,
    confidence: (row.confidence as number) ?? 0,
    source: row.source as string,
    enabled: Boolean(row.enabled),
    applied_count: (row.applied_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createRule(
  rule: Omit<DbEvolutionRule, "id" | "created_at" | "updated_at" | "applied_count">
): DbEvolutionRule {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO evolution_rules (rule_type, target_key, condition_json, action, confidence, source, enabled, applied_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      rule.rule_type,
      rule.target_key ?? null,
      toJson(rule.condition_json),
      rule.action,
      rule.confidence,
      rule.source,
      rule.enabled ? 1 : 0,
      now,
      now
    );
  return { ...rule, applied_count: 0, id: Number(result.lastInsertRowid), created_at: now, updated_at: now };
}

export function listRules(filters?: {
  ruleType?: DbRuleType;
  enabled?: boolean;
  source?: string;
}): DbEvolutionRule[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters?.ruleType) {
    conditions.push("rule_type = ?");
    params.push(filters.ruleType);
  }
  if (filters?.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(filters.enabled ? 1 : 0);
  }
  if (filters?.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM evolution_rules ${where} ORDER BY confidence DESC, created_at DESC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToRule);
}

export function getRule(id: number): DbEvolutionRule | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM evolution_rules WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRule(row) : undefined;
}

export function updateRule(
  id: number,
  updates: Partial<Omit<DbEvolutionRule, "id" | "created_at">>
): DbEvolutionRule | undefined {
  const db = getDb();
  const existing = getRule(id);
  if (!existing) return undefined;
  const rule = { ...existing, ...updates, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE evolution_rules SET
      rule_type = ?, target_key = ?, condition_json = ?, action = ?, confidence = ?,
      source = ?, enabled = ?, applied_count = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    rule.rule_type,
    rule.target_key ?? null,
    toJson(rule.condition_json),
    rule.action,
    rule.confidence,
    rule.source,
    rule.enabled ? 1 : 0,
    rule.applied_count,
    rule.updated_at,
    id
  );
  return rule;
}

export function incrementRuleAppliedCount(id: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE evolution_rules SET applied_count = applied_count + 1, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), id);
}

export function deleteRule(id: number): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM evolution_rules WHERE id = ?").run(id).changes > 0;
}
