import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";

/**
 * 模板设计技能库（2026-08-03 模板自进化）。
 * 「调研学习」把全网优秀模板的设计经验蒸馏为一条条技能存入此表，
 * 生成模板时按内容形式匹配注入 prompt，随使用不断累积进化。
 */

export interface DbTemplateSkill {
  id: number;
  content_form?: string;
  elements: Record<string, unknown>;
  skill: string;
  source?: string;
  use_count: number;
  created_at: string;
}

function rowToSkill(row: Record<string, unknown>): DbTemplateSkill {
  return {
    id: row.id as number,
    content_form: (row.content_form as string) || undefined,
    elements: fromJson(row.elements as string) as Record<string, unknown>,
    skill: row.skill as string,
    source: (row.source as string) || undefined,
    use_count: (row.use_count as number) ?? 0,
    created_at: row.created_at as string,
  };
}

export function addSkill(input: {
  contentForm?: string;
  elements?: Record<string, unknown>;
  skill: string;
  source?: string;
}): DbTemplateSkill {
  const db = getDb();
  const result = db.prepare(
    `INSERT INTO template_skills (content_form, elements, skill, source) VALUES (?, ?, ?, ?)`
  ).run(input.contentForm ?? null, toJson(input.elements ?? {}), input.skill, input.source ?? null);
  return getSkill(result.lastInsertRowid as number)!;
}

export function getSkill(id: number): DbTemplateSkill | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM template_skills WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : undefined;
}

/**
 * 列出生成时可注入的技能。同内容形式的技能优先，其余按创建时间倒序。
 */
export function listSkills(contentForm?: string, limit = 20): DbTemplateSkill[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM template_skills
     ORDER BY (CASE WHEN content_form = ? THEN 0 ELSE 1 END), created_at DESC
     LIMIT ?`
  ).all(contentForm ?? "", limit) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

export function deleteSkill(id: number): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM template_skills WHERE id = ?").run(id).changes > 0;
}

export function touchSkill(id: number): void {
  const db = getDb();
  db.prepare("UPDATE template_skills SET use_count = use_count + 1 WHERE id = ?").run(id);
}

/** 与已有技能文本去重（调研反复跑时避免同义技能膨胀） */
export function findSimilarSkill(skillText: string): DbTemplateSkill | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM template_skills WHERE skill = ?").get(skillText) as Record<string, unknown> | undefined;
  return row ? rowToSkill(row) : undefined;
}
