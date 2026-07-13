import { getDb } from "./connection.js";
import type { DbContentSchedule } from "./types.js";

function rowToSchedule(row: Record<string, unknown>): DbContentSchedule {
  return {
    id: row.id as string,
    work_id: (row.work_id as string) || undefined,
    account_id: (row.account_id as string) || undefined,
    title: row.title as string,
    description: (row.description as string) || "",
    scheduled_date: row.scheduled_date as string,
    scheduled_time: (row.scheduled_time as string) || undefined,
    platform: (row.platform as string) || "",
    content_type: row.content_type as DbContentSchedule["content_type"],
    status: row.status as DbContentSchedule["status"],
    color: (row.color as string) || undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createSchedule(entry: DbContentSchedule): DbContentSchedule {
  const db = getDb();
  db.prepare(
    `INSERT INTO content_schedule
       (id, work_id, account_id, title, description, scheduled_date,
        scheduled_time, platform, content_type, status, color,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id,
    entry.work_id ?? null,
    entry.account_id ?? null,
    entry.title,
    entry.description,
    entry.scheduled_date,
    entry.scheduled_time ?? null,
    entry.platform,
    entry.content_type,
    entry.status,
    entry.color ?? null,
    entry.created_at,
    entry.updated_at,
  );
  return entry;
}

export function getSchedule(id: string): DbContentSchedule | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM content_schedule WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSchedule(row) : undefined;
}

export function listByDateRange(from: string, to: string): DbContentSchedule[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM content_schedule WHERE scheduled_date >= ? AND scheduled_date <= ? ORDER BY scheduled_date, scheduled_time"
  ).all(from, to) as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}

export function listByMonth(yearMonth: string): DbContentSchedule[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM content_schedule WHERE scheduled_date LIKE ? ORDER BY scheduled_date, scheduled_time"
  ).all(`${yearMonth}%`) as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}

export function getMonthCounts(yearMonth: string): Record<string, number> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT scheduled_date, COUNT(*) AS cnt FROM content_schedule WHERE scheduled_date LIKE ? GROUP BY scheduled_date"
  ).all(`${yearMonth}%`) as Array<{ scheduled_date: string; cnt: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    const day = row.scheduled_date.slice(-2); // extract "DD" from "YYYY-MM-DD"
    counts[day] = row.cnt;
  }
  return counts;
}

export function updateSchedule(
  id: string,
  updates: Partial<DbContentSchedule>,
): DbContentSchedule | undefined {
  const db = getDb();
  const existing = getSchedule(id);
  if (!existing) return undefined;

  const entry = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE content_schedule
     SET work_id = ?, account_id = ?, title = ?, description = ?,
         scheduled_date = ?, scheduled_time = ?, platform = ?,
         content_type = ?, status = ?, color = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    entry.work_id ?? null,
    entry.account_id ?? null,
    entry.title,
    entry.description,
    entry.scheduled_date,
    entry.scheduled_time ?? null,
    entry.platform,
    entry.content_type,
    entry.status,
    entry.color ?? null,
    entry.updated_at,
    id,
  );
  return entry;
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM content_schedule WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listByWork(workId: string): DbContentSchedule[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM content_schedule WHERE work_id = ? ORDER BY scheduled_date, scheduled_time"
  ).all(workId) as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}

export function listByAccount(accountId: string): DbContentSchedule[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM content_schedule WHERE account_id = ? ORDER BY scheduled_date, scheduled_time"
  ).all(accountId) as Record<string, unknown>[];
  return rows.map(rowToSchedule);
}
