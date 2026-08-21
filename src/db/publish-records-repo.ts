import { getDb } from "./connection.js";
import type { DbPublishRecord, DbPublishRecordStatus } from "./types.js";

function rowToRecord(row: Record<string, unknown>): DbPublishRecord {
  return {
    id: row.id as number,
    work_id: row.work_id as string,
    platform: row.platform as string,
    account_id: (row.account_id as string) || undefined,
    platform_post_id: (row.platform_post_id as string) || undefined,
    status: row.status as DbPublishRecordStatus,
    scheduled_at: (row.scheduled_at as string) || undefined,
    published_at: (row.published_at as string) || undefined,
    error_message: (row.error_message as string) || undefined,
    metadata: (row.metadata as string) || "{}",
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPublishRecord(
  record: Omit<DbPublishRecord, "id" | "created_at" | "updated_at">
): DbPublishRecord {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO publish_records (work_id, platform, account_id, platform_post_id, status, scheduled_at, published_at, error_message, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.work_id,
      record.platform,
      record.account_id ?? null,
      record.platform_post_id ?? null,
      record.status,
      record.scheduled_at ?? null,
      record.published_at ?? null,
      record.error_message ?? null,
      record.metadata ?? "{}",
      now,
      now
    );
  return { ...record, metadata: record.metadata ?? "{}", id: Number(result.lastInsertRowid), created_at: now, updated_at: now };
}

export function getPublishRecord(id: number): DbPublishRecord | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM publish_records WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function listPublishRecords(filters?: {
  workId?: string;
  platform?: string;
  accountId?: string;
  status?: DbPublishRecordStatus;
}): DbPublishRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters?.workId) {
    conditions.push("work_id = ?");
    params.push(filters.workId);
  }
  if (filters?.platform) {
    conditions.push("platform = ?");
    params.push(filters.platform);
  }
  if (filters?.accountId) {
    conditions.push("account_id = ?");
    params.push(filters.accountId);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM publish_records ${where} ORDER BY published_at DESC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function updatePublishRecord(
  id: number,
  updates: Partial<Omit<DbPublishRecord, "id" | "created_at">>
): DbPublishRecord | undefined {
  const db = getDb();
  return db.transaction(() => {
    const existing = getPublishRecord(id);
    if (!existing) return undefined;
    const record = { ...existing, ...updates, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE publish_records SET
        work_id = ?, platform = ?, account_id = ?, platform_post_id = ?, status = ?, scheduled_at = ?, published_at = ?,
        error_message = ?, metadata = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      record.work_id,
      record.platform,
      record.account_id ?? null,
      record.platform_post_id ?? null,
      record.status,
      record.scheduled_at ?? null,
      record.published_at ?? null,
      record.error_message ?? null,
      record.metadata ?? "{}",
      record.updated_at,
      id
    );
    return record;
  })();
}

export function deletePublishRecord(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM publish_records WHERE id = ?").run(id);
  return result.changes > 0;
}
