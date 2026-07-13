import { getDb } from "./connection.js";
import type { DbBannedWord } from "./types.js";

function rowToBannedWord(row: Record<string, unknown>): DbBannedWord {
  return {
    id: row.id as number,
    platform: row.platform as string,
    word: row.word as string,
    severity: row.severity as DbBannedWord["severity"],
    created_at: row.created_at as string,
  };
}

export function createBannedWord(word: Omit<DbBannedWord, "id" | "created_at">): DbBannedWord {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO compliance_banned_words (platform, word, severity) VALUES (?, ?, ?)"
  ).run(word.platform, word.word, word.severity);
  return {
    ...word,
    id: Number(result.lastInsertRowid),
    created_at: new Date().toISOString(),
  };
}

export function listBannedWords(platform?: string, severity?: "low" | "medium" | "high"): DbBannedWord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (platform) {
    conditions.push("(platform = ? OR platform = 'all')");
    params.push(platform);
  }
  if (severity) {
    conditions.push("severity = ?");
    params.push(severity);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM compliance_banned_words ${where} ORDER BY id DESC`).all(...params) as Record<string, unknown>[];
  return rows.map(rowToBannedWord);
}

export function deleteBannedWord(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM compliance_banned_words WHERE id = ?").run(id);
  return result.changes > 0;
}
