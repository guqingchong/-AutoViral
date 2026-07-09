import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";

export type TemplateStatus = "draft" | "candidate" | "approved" | "archived";

export interface TemplateVariable {
  name: string;
  type: "text" | "image" | "video" | "audio" | "number" | "color";
  default?: string | number;
  label?: string;
}

export interface TemplateCanvas {
  width: number;
  height: number;
  fps: number;
  backgroundColor?: string;
}

export interface DbTemplate {
  id: string;
  name: string;
  content_form?: string;
  canvas: TemplateCanvas;
  variables: TemplateVariable[];
  layers: Record<string, unknown>[];
  audio: Record<string, unknown>[];
  subtitles?: Record<string, unknown>;
  transitions: Record<string, unknown>[];
  preview_url?: string;
  status: TemplateStatus;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: Record<string, unknown>): DbTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    content_form: (row.content_form as string) || undefined,
    canvas: fromJson(row.canvas as string) as TemplateCanvas,
    variables: fromJson(row.variables as string) as TemplateVariable[],
    layers: fromJson(row.layers as string) as Record<string, unknown>[],
    audio: fromJson(row.audio as string) as Record<string, unknown>[],
    subtitles: row.subtitles ? fromJson(row.subtitles as string) as Record<string, unknown> | undefined : undefined,
    transitions: fromJson(row.transitions as string) as Record<string, unknown>[],
    preview_url: (row.preview_url as string) || undefined,
    status: row.status as TemplateStatus,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createTemplate(template: Omit<DbTemplate, "created_at" | "updated_at">): DbTemplate {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO templates (id, name, content_form, canvas, variables, layers, audio, subtitles, transitions, preview_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    template.id,
    template.name,
    template.content_form ?? null,
    toJson(template.canvas),
    toJson(template.variables),
    toJson(template.layers),
    toJson(template.audio),
    template.subtitles ? toJson(template.subtitles) : null,
    toJson(template.transitions),
    template.preview_url ?? null,
    template.status,
    now,
    now
  );
  return { ...template, created_at: now, updated_at: now };
}

export function getTemplate(id: string): DbTemplate | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTemplate(row) : undefined;
}

export function listTemplates(status?: TemplateStatus, contentForm?: string, limit = 100): DbTemplate[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (contentForm) { clauses.push("content_form = ?"); params.push(contentForm); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM templates ${where} ORDER BY updated_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToTemplate);
}

export function updateTemplate(id: string, updates: Partial<DbTemplate>): DbTemplate | undefined {
  const existing = getTemplate(id);
  if (!existing) return undefined;
  const template: DbTemplate = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  const db = getDb();
  db.prepare(
    `UPDATE templates SET
      name = ?, content_form = ?, canvas = ?, variables = ?, layers = ?, audio = ?, subtitles = ?,
      transitions = ?, preview_url = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    template.name,
    template.content_form ?? null,
    toJson(template.canvas),
    toJson(template.variables),
    toJson(template.layers),
    toJson(template.audio),
    template.subtitles ? toJson(template.subtitles) : null,
    toJson(template.transitions),
    template.preview_url ?? null,
    template.status,
    template.updated_at,
    id
  );
  return template;
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  return result.changes > 0;
}
