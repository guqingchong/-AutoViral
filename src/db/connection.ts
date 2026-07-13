import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config.js";

function getDbPath(): string {
  return join(getConfigDir(), "autoviral.db");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    mkdirSync(getConfigDir(), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function resetInMemoryDb(): Database.Database {
  closeDb();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}
