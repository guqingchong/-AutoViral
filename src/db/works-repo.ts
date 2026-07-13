import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbWork, DbPipelineStep } from "./types.js";

function rowToWork(row: Record<string, unknown>): DbWork {
  return {
    id: row.id as string,
    title: row.title as string,
    type: row.type as DbWork["type"],
    content_category: (row.content_category as string) || undefined,
    content_form: (row.content_form as string) || undefined,
    video_source: (row.video_source as string) || undefined,
    video_search_query: (row.video_search_query as string) || undefined,
    status: row.status as DbWork["status"],
    platforms: fromJson<string[]>(row.platforms as string) ?? [],
    evaluation_mode: Boolean(row.evaluation_mode),
    topic_hint: (row.topic_hint as string) || undefined,
    topic_id: (row.topic_id as number) || undefined,
    article_id: (row.article_id as number) || undefined,
    script_id: (row.script_id as number) || undefined,
    digital_human_id: (row.digital_human_id as string) || undefined,
    cli_session_id: (row.cli_session_id as string) || undefined,
    account_id: (row.account_id as string) || undefined,
    eval_session_ids: fromJson<Record<string, string>>(row.eval_session_ids as string) ?? {},
    eval_attempts: fromJson<Record<string, number>>(row.eval_attempts as string) ?? {},
    topic_category: (row.topic_category as string) || undefined,
    emotion_type: (row.emotion_type as string) || undefined,
    hook_type: (row.hook_type as string) || undefined,
    template_id: (row.template_id as string) || undefined,
    tags: fromJson<string[]>(row.tags as string) ?? [],
    estimated_cost: (row.estimated_cost as number) || undefined,
    actual_cost: (row.actual_cost as number) || undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToStep(row: Record<string, unknown>): DbPipelineStep {
  return {
    work_id: row.work_id as string,
    step_key: row.step_key as string,
    name: row.name as string,
    status: row.status as DbPipelineStep["status"],
    started_at: (row.started_at as string) || undefined,
    completed_at: (row.completed_at as string) || undefined,
    note: (row.note as string) || undefined,
    sort_order: (row.sort_order as number) ?? 0,
  };
}

export function createWork(work: DbWork, steps: DbPipelineStep[]): DbWork {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO works (id, title, type, content_category, content_form, video_source, video_search_query, status, platforms, evaluation_mode, topic_hint, topic_id, article_id, script_id, digital_human_id, cli_session_id, account_id, eval_session_ids, eval_attempts, topic_category, emotion_type, hook_type, template_id, tags, estimated_cost, actual_cost, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertStep = db.prepare(
    `INSERT INTO pipeline_steps (work_id, step_key, name, status, started_at, completed_at, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    insert.run(
      work.id,
      work.title,
      work.type,
      work.content_category ?? null,
      work.content_form ?? null,
      work.video_source ?? null,
      work.video_search_query ?? null,
      work.status,
      toJson(work.platforms),
      work.evaluation_mode ? 1 : 0,
      work.topic_hint ?? null,
      work.topic_id ?? null,
      work.article_id ?? null,
      work.script_id ?? null,
      work.digital_human_id ?? null,
      work.cli_session_id ?? null,
      work.account_id ?? null,
      toJson(work.eval_session_ids ?? {}),
      toJson(work.eval_attempts ?? {}),
      work.topic_category ?? null,
      work.emotion_type ?? null,
      work.hook_type ?? null,
      work.template_id ?? null,
      toJson(work.tags),
      work.estimated_cost ?? 0,
      work.actual_cost ?? 0,
      work.created_at,
      work.updated_at
    );
    for (const step of steps) {
      insertStep.run(
        step.work_id,
        step.step_key,
        step.name,
        step.status,
        step.started_at ?? null,
        step.completed_at ?? null,
        step.note ?? null,
        step.sort_order
      );
    }
  });
  tx();
  return work;
}

export function getWork(id: string): DbWork | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM works WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToWork(row) : undefined;
}

export function getWorkWithSteps(id: string): { work: DbWork; steps: DbPipelineStep[] } | undefined {
  const work = getWork(id);
  if (!work) return undefined;
  const steps = getWorkSteps(id);
  return { work, steps };
}

export function getWorkSteps(id: string): DbPipelineStep[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM pipeline_steps WHERE work_id = ? ORDER BY sort_order")
    .all(id) as Record<string, unknown>[];
  return rows.map(rowToStep);
}

export function listWorks(): DbWork[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM works ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToWork);
}

export function updateWork(id: string, updates: Partial<DbWork>): DbWork | undefined {
  const db = getDb();
  const existing = getWork(id);
  if (!existing) return undefined;
  const work = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE works SET
      title = ?, type = ?, content_category = ?, content_form = ?, video_source = ?, video_search_query = ?,
      status = ?, platforms = ?, evaluation_mode = ?, topic_hint = ?, topic_id = ?, article_id = ?, script_id = ?, digital_human_id = ?, cli_session_id = ?, account_id = ?, eval_session_ids = ?, eval_attempts = ?,
      topic_category = ?, emotion_type = ?, hook_type = ?, template_id = ?, tags = ?, estimated_cost = ?, actual_cost = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    work.title,
    work.type,
    work.content_category ?? null,
    work.content_form ?? null,
    work.video_source ?? null,
    work.video_search_query ?? null,
    work.status,
    toJson(work.platforms),
    work.evaluation_mode ? 1 : 0,
    work.topic_hint ?? null,
    work.topic_id ?? null,
    work.article_id ?? null,
    work.script_id ?? null,
    work.digital_human_id ?? null,
    work.cli_session_id ?? null,
    work.account_id ?? null,
    toJson(work.eval_session_ids ?? {}),
    toJson(work.eval_attempts ?? {}),
    work.topic_category ?? null,
    work.emotion_type ?? null,
    work.hook_type ?? null,
    work.template_id ?? null,
    toJson(work.tags),
    work.estimated_cost ?? 0,
    work.actual_cost ?? 0,
    work.updated_at,
    id
  );
  return work;
}

export function deleteWork(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM pipeline_steps WHERE work_id = ?").run(id);
    return db.prepare("DELETE FROM works WHERE id = ?").run(id);
  });
  return tx().changes > 0;
}

export function workExists(id: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM works WHERE id = ?").get(id);
  return row !== undefined;
}

export function updateStep(
  workId: string,
  stepKey: string,
  updates: Partial<DbPipelineStep>
): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM pipeline_steps WHERE work_id = ? AND step_key = ?")
    .get(workId, stepKey) as Record<string, unknown> | undefined;
  if (!existing) return;
  const step = { ...rowToStep(existing), ...updates, work_id: workId, step_key: stepKey };
  db.prepare(
    `UPDATE pipeline_steps SET name = ?, status = ?, started_at = ?, completed_at = ?, note = ?, sort_order = ?
     WHERE work_id = ? AND step_key = ?`
  ).run(
    step.name,
    step.status,
    step.started_at ?? null,
    step.completed_at ?? null,
    step.note ?? null,
    step.sort_order,
    workId,
    stepKey
  );
}
