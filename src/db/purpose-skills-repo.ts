/**
 * 用途技能包存储（2026-08-18 04 方案，migrate v26）。
 * 按用途沉淀调研蒸馏的技能条目（钩子公式/结构模板/话术/合规要点），
 * 作品创建时按 purpose 注入 agent prompt；权重随三率回流调整。
 */

import { getDb } from "./connection.js";

export interface DbPurposeSkill {
  id: number;
  purpose: string;
  skill: string;
  source?: string;
  weight: number;
  use_count: number;
  created_at: string;
}

function rowToSkill(row: Record<string, unknown>): DbPurposeSkill {
  return {
    id: row.id as number,
    purpose: row.purpose as string,
    skill: row.skill as string,
    source: (row.source as string) || undefined,
    weight: (row.weight as number) ?? 1,
    use_count: (row.use_count as number) ?? 0,
    created_at: row.created_at as string,
  };
}

/** 入库（purpose+skill 唯一约束去重；重复命中改为 weight+0.1 强化） */
export function addPurposeSkill(input: { purpose: string; skill: string; source?: string }): { added: boolean } {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM purpose_skills WHERE purpose = ? AND skill = ?")
    .get(input.purpose, input.skill) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE purpose_skills SET weight = MIN(weight + 0.1, 2.0), use_count = use_count + 1, updated_at = datetime('now') WHERE id = ?")
      .run(existing.id);
    return { added: false };
  }
  db.prepare("INSERT INTO purpose_skills (purpose, skill, source) VALUES (?, ?, ?)")
    .run(input.purpose, input.skill, input.source ?? null);
  return { added: true };
}

/** 取某用途的技能包（权重降序；limit 控制注入长度） */
export function listPurposeSkills(purpose: string, limit = 20): DbPurposeSkill[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM purpose_skills WHERE purpose = ? ORDER BY weight DESC, use_count DESC, id DESC LIMIT ?",
  ).all(purpose, limit) as Record<string, unknown>[];
  return rows.map(rowToSkill);
}

export function countPurposeSkills(purpose: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS c FROM purpose_skills WHERE purpose = ?").get(purpose) as { c: number };
  return row.c;
}

/** 技能包注入文本（prompt 段）；无技能时返回空串 */
export function purposeSkillsBlock(purpose: string, limit = 12): string {
  const skills = listPurposeSkills(purpose, limit);
  if (!skills.length) return "";
  return [
    `【${purpose} 用途技能包（调研沉淀，须遵守）】`,
    ...skills.map((s, i) => `${i + 1}. ${s.skill}`),
  ].join("\n");
}
