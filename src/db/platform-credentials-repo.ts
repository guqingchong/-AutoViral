import { getDb } from "./connection.js";

export interface PlatformCredential {
  id: number;
  platform: string;
  key_type: string;
  value: string;
  created_at: string;
  updated_at: string;
}

function rowToCredential(row: Record<string, unknown>): PlatformCredential {
  return {
    id: row.id as number,
    platform: row.platform as string,
    key_type: row.key_type as string,
    value: row.value as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function setCredential(platform: string, keyType: string, value: string): PlatformCredential {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO platform_credentials (platform, key_type, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform, key_type) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(platform, keyType, value, now, now);
  const row = db.prepare(
    "SELECT * FROM platform_credentials WHERE platform = ? AND key_type = ?"
  ).get(platform, keyType) as Record<string, unknown>;
  return rowToCredential(row);
}

export function getCredential(platform: string, keyType: string): string | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM platform_credentials WHERE platform = ? AND key_type = ?"
  ).get(platform, keyType) as { value: string } | undefined;
  return row?.value;
}

export function getCredentialsByPlatform(platform: string): PlatformCredential[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM platform_credentials WHERE platform = ? ORDER BY key_type"
  ).all(platform) as Record<string, unknown>[];
  return rows.map(rowToCredential);
}

export function deleteCredential(platform: string, keyType: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM platform_credentials WHERE platform = ? AND key_type = ?"
  ).run(platform, keyType);
  return result.changes > 0;
}
