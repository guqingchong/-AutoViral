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

export function listBannedWords(platform?: string): DbBannedWord[] {
  const db = getDb();
  const rows = platform
    ? db.prepare("SELECT * FROM compliance_banned_words WHERE platform = ? OR platform = 'all' ORDER BY id DESC").all(platform)
    : db.prepare("SELECT * FROM compliance_banned_words ORDER BY id DESC").all();
  return (rows as Record<string, unknown>[]).map(rowToBannedWord);
}

export function deleteBannedWord(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM compliance_banned_words WHERE id = ?").run(id);
  return result.changes > 0;
}
