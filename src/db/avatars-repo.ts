import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbAvatar } from "./types.js";

function rowToAvatar(row: Record<string, unknown>): DbAvatar {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as DbAvatar["status"],
    source: row.source as DbAvatar["source"],
    reference_video_path: (row.reference_video_path as string) || undefined,
    preview_url: (row.preview_url as string) || undefined,
    provider_avatar_id: (row.provider_avatar_id as string) || undefined,
    config: fromJson(row.config as string) ?? {},
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createAvatar(avatar: DbAvatar): DbAvatar {
  const db = getDb();
  db.prepare(
    `INSERT INTO avatars (id, name, status, source, reference_video_path, preview_url, provider_avatar_id, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    avatar.id,
    avatar.name,
    avatar.status,
    avatar.source,
    avatar.reference_video_path ?? null,
    avatar.preview_url ?? null,
    avatar.provider_avatar_id ?? null,
    toJson(avatar.config),
    avatar.created_at,
    avatar.updated_at
  );
  return avatar;
}

export function getAvatar(id: string): DbAvatar | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM avatars WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToAvatar(row) : undefined;
}

export function listAvatars(): DbAvatar[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM avatars ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToAvatar);
}

export function updateAvatar(id: string, updates: Partial<DbAvatar>): DbAvatar | undefined {
  const db = getDb();
  const existing = getAvatar(id);
  if (!existing) return undefined;
  const avatar = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE avatars SET name = ?, status = ?, source = ?, reference_video_path = ?, preview_url = ?, provider_avatar_id = ?, config = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    avatar.name,
    avatar.status,
    avatar.source,
    avatar.reference_video_path ?? null,
    avatar.preview_url ?? null,
    avatar.provider_avatar_id ?? null,
    toJson(avatar.config),
    avatar.updated_at,
    id
  );
  return avatar;
}

export function deleteAvatar(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM avatars WHERE id = ?").run(id);
  return result.changes > 0;
}
