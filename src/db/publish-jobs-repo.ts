import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { ComplianceResult, DbPublishJob } from "./types.js";

function rowToJob(row: Record<string, unknown>): DbPublishJob {
  return {
    id: row.id as string,
    work_id: (row.work_id as string) ?? null,
    render_job_id: (row.render_job_id as string) ?? null,
    account_id: row.account_id as string,
    platform: row.platform as string,
    title: row.title as string,
    content: row.content as string,
    media_path: (row.media_path as string) ?? null,
    status: row.status as DbPublishJob["status"],
    compliance_result: fromJson<ComplianceResult>(row.compliance_result as string) ?? { passed: true, violations: [] },
    error: (row.error as string) ?? null,
    post_url: (row.post_url as string) ?? null,
    published_at: (row.published_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createJob(job: DbPublishJob): DbPublishJob {
  const db = getDb();
  db.prepare(
    `INSERT INTO publish_jobs (id, work_id, render_job_id, account_id, platform, title, content, media_path, status, compliance_result, error, post_url, published_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.work_id ?? null,
    job.render_job_id ?? null,
    job.account_id,
    job.platform,
    job.title,
    job.content,
    job.media_path ?? null,
    job.status,
    toJson(job.compliance_result),
    job.error ?? null,
    job.post_url ?? null,
    job.published_at ?? null,
    job.created_at,
    job.updated_at
  );
  return job;
}

export function getJob(id: string): DbPublishJob | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM publish_jobs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listJobs(options?: { status?: string; workId?: string; limit?: number; offset?: number }): DbPublishJob[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (options?.status) { conditions.push("status = ?"); params.push(options.status); }
  if (options?.workId) { conditions.push("work_id = ?"); params.push(options.workId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  const rows = db.prepare(`SELECT * FROM publish_jobs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function updateJob(id: string, updates: Partial<DbPublishJob>): DbPublishJob | undefined {
  const db = getDb();
  const existing = getJob(id);
  if (!existing) return undefined;
  const job = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE publish_jobs SET
      work_id = ?, render_job_id = ?, account_id = ?, platform = ?, title = ?, content = ?, media_path = ?,
      status = ?, compliance_result = ?, error = ?, post_url = ?, published_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    job.work_id ?? null,
    job.render_job_id ?? null,
    job.account_id,
    job.platform,
    job.title,
    job.content,
    job.media_path ?? null,
    job.status,
    toJson(job.compliance_result),
    job.error ?? null,
    job.post_url ?? null,
    job.published_at ?? null,
    job.updated_at,
    id
  );
  return job;
}

export function deleteJob(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM publish_jobs WHERE id = ?").run(id);
  return result.changes > 0;
}
