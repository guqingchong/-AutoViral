import { getDb } from "./connection.js";
import { fromJson } from "./json.js";

export interface DbEvalResult {
  id: number;
  work_id: string;
  overall_score?: number;
  dimensions: Record<string, unknown>;
  summary?: string;
  created_at: string;
}

function rowToEvalResult(row: Record<string, unknown>): DbEvalResult {
  return {
    id: row.id as number,
    work_id: row.work_id as string,
    overall_score: (row.overall_score as number) || undefined,
    dimensions: fromJson(row.dimensions as string) ?? {},
    summary: (row.summary as string) || undefined,
    created_at: row.created_at as string,
  };
}

export function getEvalResultByWorkId(workId: string): DbEvalResult | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM eval_results WHERE work_id = ?")
    .get(workId) as Record<string, unknown> | undefined;
  return row ? rowToEvalResult(row) : undefined;
}

export function createEvalResult(
  result: Omit<DbEvalResult, "id">
): DbEvalResult {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO eval_results (work_id, overall_score, dimensions, summary, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const res = insert.run(
    result.work_id,
    result.overall_score ?? null,
    JSON.stringify(result.dimensions),
    result.summary ?? null,
    result.created_at
  );
  return { ...result, id: Number(res.lastInsertRowid) };
}

export function updateEvalResult(
  workId: string,
  updates: Partial<Omit<DbEvalResult, "id" | "work_id">>
): DbEvalResult | undefined {
  const db = getDb();
  const existing = getEvalResultByWorkId(workId);
  if (!existing) return undefined;
  const result = { ...existing, ...updates };
  db.prepare(
    `UPDATE eval_results SET overall_score = ?, dimensions = ?, summary = ?, created_at = ?
     WHERE work_id = ?`
  ).run(
    result.overall_score ?? null,
    JSON.stringify(result.dimensions),
    result.summary ?? null,
    result.created_at,
    workId
  );
  return result;
}
