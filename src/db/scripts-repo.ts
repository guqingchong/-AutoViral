import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbScript } from "./types.js";

export function createScript(script: Omit<DbScript, "id" | "created_at">): DbScript {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO scripts (work_id, article_id, content, duration, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(script.work_id ?? null, script.article_id ?? null, toJson(script.content), script.duration ?? null, script.status);
  return { ...script, id: Number(result.lastInsertRowid), created_at: new Date().toISOString() };
}

export function getScript(id: number): DbScript | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM scripts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    article_id: (row.article_id as number) || undefined,
    content: fromJson(row.content as string) ?? {},
    duration: (row.duration as number) || undefined,
    status: row.status as DbScript["status"],
    created_at: row.created_at as string,
  };
}

/** 更新脚本文案(2026-09-01 新增:assembly 重写口播回写,此前全表只有建没有改) */
export function updateScriptContent(id: number, content: unknown): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE scripts SET content = ? WHERE id = ?").run(toJson(content), id);
  return result.changes > 0;
}

export function listScriptsByWork(workId: string): DbScript[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM scripts WHERE work_id = ? ORDER BY created_at DESC").all(workId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    article_id: (row.article_id as number) || undefined,
    content: fromJson(row.content as string) ?? {},
    duration: (row.duration as number) || undefined,
    status: row.status as DbScript["status"],
    created_at: row.created_at as string,
  }));
}
