import { getDb } from "./connection.js";
import { fromJson } from "./json.js";

export interface DbEvalResult {
  id: number;
  work_id: string;
  overall_score?: number;
  dimensions: Record<string, unknown>;
  summary?: string;
  /** Q4(2026-09):评审结论 pass/fail */
  verdict?: string;
  /** Q4(2026-09):结构化问题清单（JSON 字符串） */
  issues?: string;
  /** Q4(2026-09):评审所用模型 */
  judge_model?: string;
  /** Q4(2026-09):评审是否超时降级（0/1） */
  timeout_degraded?: number;
  created_at: string;
}

function rowToEvalResult(row: Record<string, unknown>): DbEvalResult {
  return {
    id: row.id as number,
    work_id: row.work_id as string,
    overall_score: (row.overall_score as number) || undefined,
    dimensions: fromJson(row.dimensions as string) ?? {},
    summary: (row.summary as string) || undefined,
    verdict: (row.verdict as string) || undefined,
    issues: (row.issues as string) || undefined,
    judge_model: (row.judge_model as string) || undefined,
    timeout_degraded: (row.timeout_degraded as number) || undefined,
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
    `INSERT INTO eval_results (work_id, overall_score, dimensions, summary, verdict, issues, judge_model, timeout_degraded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const res = insert.run(
    result.work_id,
    result.overall_score ?? null,
    JSON.stringify(result.dimensions),
    result.summary ?? null,
    result.verdict ?? null,
    result.issues ?? null,
    result.judge_model ?? null,
    result.timeout_degraded ?? 0,
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
    `UPDATE eval_results SET overall_score = ?, dimensions = ?, summary = ?, verdict = ?, issues = ?, judge_model = ?, timeout_degraded = ?, created_at = ?
     WHERE work_id = ?`
  ).run(
    result.overall_score ?? null,
    JSON.stringify(result.dimensions),
    result.summary ?? null,
    result.verdict ?? null,
    result.issues ?? null,
    result.judge_model ?? null,
    result.timeout_degraded ?? 0,
    result.created_at,
    workId
  );
  return result;
}

/** Q4(2026-09):评审结论落库——每作品一行最新快照（work_id UNIQUE），存在则更新、否则创建 */
export function upsertEvalResult(
  workId: string,
  data: {
    overall_score?: number;
    dimensions?: Record<string, unknown>;
    summary?: string;
    verdict?: string;
    issues?: string;
    judge_model?: string;
    timeout_degraded?: number;
  }
): DbEvalResult {
  const existing = getEvalResultByWorkId(workId);
  if (existing) {
    return updateEvalResult(workId, data)!;
  }
  return createEvalResult({
    work_id: workId,
    dimensions: data.dimensions ?? {},
    overall_score: data.overall_score,
    summary: data.summary,
    verdict: data.verdict,
    issues: data.issues,
    judge_model: data.judge_model,
    timeout_degraded: data.timeout_degraded,
    created_at: new Date().toISOString(),
  });
}
