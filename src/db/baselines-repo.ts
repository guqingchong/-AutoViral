import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbBaseline } from "./types.js";

function rowToBaseline(row: Record<string, unknown>): DbBaseline {
  return {
    id: row.id as number,
    metric_name: row.metric_name as string,
    platform: (row.platform as string) || undefined,
    value_json: fromJson(row.value_json as string) as Record<string, unknown>,
    sample_count: (row.sample_count as number) ?? 0,
    computed_at: row.computed_at as string,
  };
}

export function createBaseline(baseline: Omit<DbBaseline, "id">): DbBaseline {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO baselines (metric_name, platform, value_json, sample_count, computed_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      baseline.metric_name,
      baseline.platform ?? null,
      toJson(baseline.value_json),
      baseline.sample_count,
      baseline.computed_at
    );
  return { ...baseline, id: Number(result.lastInsertRowid) };
}

export function listBaselines(limit = 20): DbBaseline[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM baselines ORDER BY computed_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  return rows.map(rowToBaseline);
}

export function getLatestBaseline(metricName: string, platform?: string): DbBaseline | undefined {
  const db = getDb();
  const sql = platform
    ? "SELECT * FROM baselines WHERE metric_name = ? AND platform = ? ORDER BY computed_at DESC LIMIT 1"
    : "SELECT * FROM baselines WHERE metric_name = ? AND platform IS NULL ORDER BY computed_at DESC LIMIT 1";
  const row = platform
    ? (db.prepare(sql).get(metricName, platform) as Record<string, unknown> | undefined)
    : (db.prepare(sql).get(metricName) as Record<string, unknown> | undefined);
  return row ? rowToBaseline(row) : undefined;
}
