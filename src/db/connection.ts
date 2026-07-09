import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_DIR = join(homedir(), ".autoviral");
const DB_PATH = join(DB_DIR, "autoviral.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
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
