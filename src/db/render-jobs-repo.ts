import { getDb } from "./connection.js";

export type RenderJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface DbRenderJob {
  id: string;
  work_id?: string;
  template_id?: string;
  output_path?: string;
  status: RenderJobStatus;
  progress: number;
  duration?: number;
  current_time?: number;
  error?: string;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: Record<string, unknown>): DbRenderJob {
  return {
    id: row.id as string,
    work_id: (row.work_id as string) || undefined,
    template_id: (row.template_id as string) || undefined,
    output_path: (row.output_path as string) || undefined,
    status: row.status as RenderJobStatus,
    progress: (row.progress as number) ?? 0,
    duration: (row.duration as number) || undefined,
    current_time: (row.current_time as number) || undefined,
    error: (row.error as string) || undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createRenderJob(job: Omit<DbRenderJob, "created_at" | "updated_at">): DbRenderJob {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO render_jobs (id, work_id, template_id, output_path, status, progress, duration, current_time, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.work_id ?? null,
    job.template_id ?? null,
    job.output_path ?? null,
    job.status,
    job.progress,
    job.duration ?? null,
    job.current_time ?? null,
    job.error ?? null,
    now,
    now
  );
  return { ...job, created_at: now, updated_at: now };
}

export function getRenderJob(id: string): DbRenderJob | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM render_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : undefined;
}

export function updateRenderJob(id: string, updates: Partial<DbRenderJob>): DbRenderJob | undefined {
  const db = getDb();
  return db.transaction(() => {
    const existing = getRenderJob(id);
    if (!existing) return undefined;
    const job: DbRenderJob = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE render_jobs SET work_id = ?, template_id = ?, output_path = ?, status = ?, progress = ?, duration = ?, current_time = ?, error = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      job.work_id ?? null,
      job.template_id ?? null,
      job.output_path ?? null,
      job.status,
      job.progress,
      job.duration ?? null,
      job.current_time ?? null,
      job.error ?? null,
      job.updated_at,
      id
    );
    return job;
  })();
}

export function listRenderJobs(status?: RenderJobStatus, workId?: string, limit = 100): DbRenderJob[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (workId) { clauses.push("work_id = ?"); params.push(workId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM render_jobs ${where} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToJob);
}
