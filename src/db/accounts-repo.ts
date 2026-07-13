import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbAccount } from "./types.js";

function rowToAccount(row: Record<string, unknown>): DbAccount {
  return {
    id: row.id as string,
    name: row.name as string,
    platform: row.platform as string,
    tone_profile: fromJson(row.tone_profile as string) ?? {},
    status: row.status as DbAccount["status"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createAccount(account: DbAccount): DbAccount {
  const db = getDb();
  db.prepare(
    `INSERT INTO accounts (id, name, platform, tone_profile, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    account.id,
    account.name,
    account.platform,
    toJson(account.tone_profile),
    account.status,
    account.created_at,
    account.updated_at
  );
  return account;
}

export function getAccount(id: string): DbAccount | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAccount(row) : undefined;
}

export function listAccounts(): DbAccount[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM accounts ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToAccount);
}

export function updateAccount(id: string, updates: Partial<DbAccount>): DbAccount | undefined {
  const db = getDb();
  const existing = getAccount(id);
  if (!existing) return undefined;
  const account = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE accounts SET name = ?, platform = ?, tone_profile = ?, status = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    account.name,
    account.platform,
    toJson(account.tone_profile),
    account.status,
    account.updated_at,
    id
  );
  return account;
}

export function deleteAccount(id: string): boolean {
  const db = getDb();
  const refCount = db.prepare("SELECT COUNT(*) AS cnt FROM works WHERE account_id = ?").get(id) as { cnt: number };
  if (refCount.cnt > 0) {
    throw new Error(`Cannot delete account: ${refCount.cnt} work(s) still reference it`);
  }
  const result = db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getWorksByAccount(accountId: string): Array<{ id: string; title: string }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, title FROM works WHERE account_id = ? ORDER BY updated_at DESC"
  ).all(accountId) as Array<{ id: string; title: string }>;
  return rows;
}
