import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbPublishAccount } from "./types.js";

function rowToAccount(row: Record<string, unknown>): DbPublishAccount {
  return {
    id: row.id as string,
    platform: row.platform as string,
    display_name: row.display_name as string,
    credentials: fromJson<Record<string, unknown>>((row.credentials as string) ?? "{}") ?? {},
    status: row.status as DbPublishAccount["status"],
    is_default: Boolean(row.is_default),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createAccount(account: DbPublishAccount): DbPublishAccount {
  const db = getDb();
  db.prepare(
    `INSERT INTO publish_accounts (id, platform, display_name, credentials, status, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    account.id,
    account.platform,
    account.display_name,
    toJson(account.credentials),
    account.status,
    account.is_default ? 1 : 0,
    account.created_at,
    account.updated_at
  );
  return account;
}

export function getAccount(id: string): DbPublishAccount | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM publish_accounts WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToAccount(row) : undefined;
}

export function listAccounts(): DbPublishAccount[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM publish_accounts ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToAccount);
}

export function updateAccount(id: string, updates: Partial<DbPublishAccount>): DbPublishAccount | undefined {
  const db = getDb();
  const existing = getAccount(id);
  if (!existing) return undefined;
  const account = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE publish_accounts SET
      platform = ?, display_name = ?, credentials = ?, status = ?, is_default = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    account.platform,
    account.display_name,
    toJson(account.credentials),
    account.status,
    account.is_default ? 1 : 0,
    account.updated_at,
    id
  );
  return account;
}

export function deleteAccount(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM publish_accounts WHERE id = ?").run(id);
  return result.changes > 0;
}

export function setDefaultAccount(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE publish_accounts SET is_default = 0").run();
    db.prepare("UPDATE publish_accounts SET is_default = 1 WHERE id = ?").run(id);
  })();
}
