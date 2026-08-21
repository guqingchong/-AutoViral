import { getDb } from "./connection.js";

export function setAccountCredential(accountId: string, keyType: string, value: string): void {
  getDb().prepare(`
    INSERT INTO account_credentials (account_id, key_type, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, key_type) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(accountId, keyType, value);
}

export function getAccountCredential(accountId: string, keyType: string): string | undefined {
  const row = getDb().prepare(
    "SELECT value FROM account_credentials WHERE account_id = ? AND key_type = ?"
  ).get(accountId, keyType) as { value: string } | undefined;
  return row?.value;
}

export function deleteAccountCredentialsByAccount(accountId: string): void {
  getDb().prepare("DELETE FROM account_credentials WHERE account_id = ?").run(accountId);
}
