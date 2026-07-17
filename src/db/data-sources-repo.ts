/**
 * Self-evolving data source tracking (PRD §4.1.1).
 *
 * When an external data source is referenced by WebSearch 5+ times, it is
 * automatically promoted to a "fixed" search data source that gets reused in
 * subsequent research, instead of being re-discovered each time.
 */

import { getDb } from "./connection.js";

export interface DbDataSource {
  id: number;
  url: string;
  platform?: string;
  title?: string;
  reference_count: number;
  fixed: boolean;
  first_seen_at: string;
  last_referenced_at?: string;
  created_at: string;
}

const PROMOTION_THRESHOLD = 5;

function rowToDataSource(row: Record<string, unknown>): DbDataSource {
  return {
    id: row.id as number,
    url: row.url as string,
    platform: (row.platform as string) || undefined,
    title: (row.title as string) || undefined,
    reference_count: (row.reference_count as number) ?? 0,
    fixed: Boolean(row.fixed),
    first_seen_at: row.first_seen_at as string,
    last_referenced_at: (row.last_referenced_at as string) || undefined,
    created_at: row.created_at as string,
  };
}

export interface RecordReferenceInput {
  url: string;
  platform?: string;
  title?: string;
}

/**
 * Record a single reference to a data source. Increments the reference count
 * and, once it crosses the promotion threshold, marks it as a fixed source.
 * Returns the updated data source row.
 */
export function recordDataSourceReference(input: RecordReferenceInput): DbDataSource {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT * FROM data_sources WHERE url = ?")
      .get(input.url) as Record<string, unknown> | undefined;

    if (existing) {
      const newCount = (existing.reference_count as number) + 1;
      db.prepare(
        "UPDATE data_sources SET reference_count = ?, last_referenced_at = ?, fixed = ?, platform = COALESCE(?, platform), title = COALESCE(?, title) WHERE url = ?"
      ).run(
        newCount,
        now,
        newCount >= PROMOTION_THRESHOLD ? 1 : (existing.fixed as number),
        input.platform ?? null,
        input.title ?? null,
        input.url
      );
    } else {
      db.prepare(
        "INSERT INTO data_sources (url, platform, title, reference_count, fixed, first_seen_at, last_referenced_at, created_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?)"
      ).run(input.url, input.platform ?? null, input.title ?? null, now, now, now);
    }

    const row = db
      .prepare("SELECT * FROM data_sources WHERE url = ?")
      .get(input.url) as Record<string, unknown>;
    return rowToDataSource(row);
  })();
}

/** List all data sources promoted to "fixed" (referenced 5+ times). */
export function listFixedDataSources(): DbDataSource[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM data_sources WHERE fixed = 1 ORDER BY reference_count DESC, last_referenced_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToDataSource);
}

/** List all tracked data sources, most-referenced first. */
export function listDataSources(limit = 100): DbDataSource[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM data_sources ORDER BY reference_count DESC, created_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToDataSource);
}

export function getDataSource(id: number): DbDataSource | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM data_sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToDataSource(row) : undefined;
}

/** Manually promote or demote a data source to/from fixed status. */
export function setFixedStatus(id: number, fixed: boolean): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE data_sources SET fixed = ? WHERE id = ?").run(fixed ? 1 : 0, id);
  return result.changes > 0;
}

export function deleteDataSource(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM data_sources WHERE id = ?").run(id);
  return result.changes > 0;
}

export const DATA_SOURCE_PROMOTION_THRESHOLD = PROMOTION_THRESHOLD;