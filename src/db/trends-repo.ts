import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbTrendSnapshot } from "./types.js";

export function createSnapshot(snapshot: Omit<DbTrendSnapshot, "id" | "created_at">): DbTrendSnapshot {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO trend_snapshots (platform, snapshot_date, raw_data, report_path)
       VALUES (?, ?, ?, ?)`
    )
    .run(snapshot.platform, snapshot.snapshot_date, toJson(snapshot.raw_data), snapshot.report_path ?? null);
  return {
    id: Number(result.lastInsertRowid),
    platform: snapshot.platform,
    snapshot_date: snapshot.snapshot_date,
    raw_data: snapshot.raw_data,
    report_path: snapshot.report_path,
    created_at: new Date().toISOString(),
  };
}

export function getLatestSnapshot(platform: string): DbTrendSnapshot | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM trend_snapshots WHERE platform = ? ORDER BY snapshot_date DESC LIMIT 1")
    .get(platform) as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row) : undefined;
}

function rowToSnapshot(row: Record<string, unknown>): DbTrendSnapshot {
  return {
    id: row.id as number,
    platform: row.platform as string,
    snapshot_date: row.snapshot_date as string,
    raw_data: fromJson(row.raw_data as string) ?? {},
    report_path: (row.report_path as string) || undefined,
    created_at: row.created_at as string,
  };
}
