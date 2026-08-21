import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbAccount } from "./types.js";

/** Thrown when attempting to delete an account that is still referenced by works. */
export class AccountReferencedError extends Error {
  public readonly code = "ACCOUNT_REFERENCED";
  constructor(public readonly workCount: number) {
    super(`Cannot delete account: ${workCount} work(s) still reference it`);
    this.name = "AccountReferencedError";
  }
}

function rowToAccount(row: Record<string, unknown>): DbAccount {
  return {
    id: row.id as string,
    name: row.name as string,
    platform: row.platform as string,
    tone_profile: fromJson(row.tone_profile as string) ?? {},
    status: row.status as DbAccount["status"],
    username: (row.username as string) || undefined,
    password: (row.password as string) || undefined,
    cookie: (row.cookie as string) || undefined,
    is_default: row.is_default as number | undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createAccount(account: DbAccount): DbAccount {
  const db = getDb();
  db.prepare(
    `INSERT INTO accounts (id, name, platform, tone_profile, status, username, password, cookie, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    account.id,
    account.name,
    account.platform,
    toJson(account.tone_profile),
    account.status,
    account.username ?? null,
    account.password ?? null,
    account.cookie ?? null,
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

/** 按平台列出账号,默认账号优先,其次按创建时间升序。 */
export function listAccountsByPlatform(platform: string): DbAccount[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM accounts WHERE platform = ? ORDER BY is_default DESC, created_at ASC").all(platform) as Record<string, unknown>[];
  return rows.map(rowToAccount);
}

/** 设置平台默认账号(同事务:该平台全清 0 再置 1)。 */
export function setDefaultAccount(platform: string, accountId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE accounts SET is_default = 0 WHERE platform = ?").run(platform);
    db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(accountId);
  })();
}

export function updateAccount(id: string, updates: Partial<DbAccount>): DbAccount | undefined {
  const db = getDb();
  const existing = getAccount(id);
  if (!existing) return undefined;
  const account = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE accounts SET name = ?, platform = ?, tone_profile = ?, status = ?, username = ?, password = ?, cookie = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    account.name,
    account.platform,
    toJson(account.tone_profile),
    account.status,
    account.username ?? null,
    account.password ?? null,
    account.cookie ?? null,
    account.updated_at,
    id
  );
  return account;
}

export function deleteAccount(id: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const refCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM works WHERE account_id = ?"
    ).get(id) as { cnt: number };
    if (refCount.cnt > 0) {
      throw new AccountReferencedError(refCount.cnt);
    }
    return db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  });
  return tx().changes > 0;
}

export function getWorksByAccount(accountId: string): Array<{ id: string; title: string }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, title FROM works WHERE account_id = ? ORDER BY updated_at DESC"
  ).all(accountId) as Array<{ id: string; title: string }>;
  return rows;
}
