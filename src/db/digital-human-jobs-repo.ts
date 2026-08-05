import { getDb } from "./connection.js";
import type { DbDigitalHumanJob } from "./types.js";

function rowToJob(row: Record<string, unknown>): DbDigitalHumanJob {
  return {
    id: row.id as string,
    work_id: (row.work_id as string) || undefined,
    avatar_id: row.avatar_id as string,
    audio_path: row.audio_path as string,
    script_id: (row.script_id as number) || undefined,
    provider: row.provider as DbDigitalHumanJob["provider"],
    status: row.status as DbDigitalHumanJob["status"],
    progress: (row.progress as number) ?? 0,
    result_url: (row.result_url as string) || undefined,
    result_local_path: (row.result_local_path as string) || undefined,
    error: (row.error as string) || undefined,
    estimated_cost: (row.estimated_cost as number) ?? 0,
    actual_cost: (row.actual_cost as number) ?? 0,
    provider_job_id: (row.provider_job_id as string) || undefined,
    queue_position: (row.queue_position as number | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createJob(job: DbDigitalHumanJob): DbDigitalHumanJob {
  const db = getDb();
  db.prepare(
    `INSERT INTO digital_human_jobs (id, work_id, avatar_id, audio_path, script_id, provider, status, progress, result_url, result_local_path, error, estimated_cost, actual_cost, provider_job_id, queue_position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.work_id ?? null,
    job.avatar_id,
    job.audio_path,
    job.script_id ?? null,
    job.provider,
    job.status,
    job.progress,
    job.result_url ?? null,
    job.result_local_path ?? null,
    job.error ?? null,
    job.estimated_cost,
    job.actual_cost,
    job.provider_job_id ?? null,
    job.queue_position ?? null,
    job.created_at,
    job.updated_at
  );
  return job;
}

export function getJob(id: string): DbDigitalHumanJob | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM digital_human_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listJobs(workId?: string): DbDigitalHumanJob[] {
  const db = getDb();
  const sql = workId ? "SELECT * FROM digital_human_jobs WHERE work_id = ? ORDER BY created_at DESC" : "SELECT * FROM digital_human_jobs ORDER BY created_at DESC";
  const rows = workId
    ? (db.prepare(sql).all(workId) as Record<string, unknown>[])
    : (db.prepare(sql).all() as Record<string, unknown>[]);
  return rows.map(rowToJob);
}

export function updateJob(id: string, updates: Partial<DbDigitalHumanJob>): DbDigitalHumanJob | undefined {
  const db = getDb();
  const existing = getJob(id);
  if (!existing) return undefined;
  const job = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE digital_human_jobs SET work_id = ?, avatar_id = ?, audio_path = ?, script_id = ?, provider = ?, status = ?, progress = ?, result_url = ?, result_local_path = ?, error = ?, estimated_cost = ?, actual_cost = ?, provider_job_id = ?, queue_position = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    job.work_id ?? null,
    job.avatar_id,
    job.audio_path,
    job.script_id ?? null,
    job.provider,
    job.status,
    job.progress,
    job.result_url ?? null,
    job.result_local_path ?? null,
    job.error ?? null,
    job.estimated_cost,
    job.actual_cost,
    job.provider_job_id ?? null,
    job.queue_position ?? null,
    job.updated_at,
    id
  );
  return job;
}

/** 渲染池：queued 任务按 queue_position 升序（NULL 排最后），同位次按创建时间 */
export function listQueuedJobsByPosition(): DbDigitalHumanJob[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM digital_human_jobs WHERE status = 'queued'
       ORDER BY queue_position IS NULL, queue_position, created_at`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function countActiveJobs(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM digital_human_jobs WHERE status IN ('pending','queued','running')").get() as { n: number };
  return row.n;
}

export function countActiveJobsByAvatar(avatarId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM digital_human_jobs WHERE avatar_id = ? AND status IN ('pending','queued','running')").get(avatarId) as { n: number };
  return row.n;
}

export function deleteJob(id: string): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM digital_human_jobs WHERE id = ?").run(id).changes > 0;
}
