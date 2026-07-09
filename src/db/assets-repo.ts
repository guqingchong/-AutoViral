import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbAsset } from "./types.js";

function rowToAsset(row: Record<string, unknown>): DbAsset {
  return {
    id: row.id as number,
    name: row.name as string,
    file_path: row.file_path as string,
    category: row.category as DbAsset["category"],
    type: row.type as DbAsset["type"],
    tags: fromJson<string[]>(row.tags as string) ?? [],
    source: row.source as DbAsset["source"],
    license: row.license as DbAsset["license"],
    compliance_status: row.compliance_status as DbAsset["compliance_status"],
    metadata: fromJson<Record<string, unknown>>(row.metadata as string) ?? {},
    usage_count: (row.usage_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createAsset(asset: Omit<DbAsset, "id" | "created_at" | "updated_at">): DbAsset {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO asset_library (name, file_path, category, type, tags, source, license, compliance_status, metadata, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    asset.name,
    asset.file_path,
    asset.category,
    asset.type,
    toJson(asset.tags),
    asset.source,
    asset.license,
    asset.compliance_status,
    toJson(asset.metadata),
    asset.usage_count,
    now,
    now
  );
  return { ...asset, id: Number(result.lastInsertRowid), created_at: now, updated_at: now };
}

export function getAsset(id: number): DbAsset | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToAsset(row) : undefined;
}

export function listAssets(filters?: { category?: string; type?: string; compliance?: string; source?: string; tag?: string; limit?: number }): DbAsset[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters?.category) { conditions.push("category = ?"); params.push(filters.category); }
  if (filters?.type) { conditions.push("type = ?"); params.push(filters.type); }
  if (filters?.compliance) { conditions.push("compliance_status = ?"); params.push(filters.compliance); }
  if (filters?.source) { conditions.push("source = ?"); params.push(filters.source); }
  if (filters?.tag) { conditions.push("tags LIKE ?"); params.push(`%"${filters.tag}"%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters?.limit ?? 200, 1000);
  const sql = `SELECT * FROM asset_library ${where} ORDER BY updated_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToAsset);
}

export function updateAsset(id: number, updates: Partial<DbAsset>): DbAsset | undefined {
  const db = getDb();
  const existing = getAsset(id);
  if (!existing) return undefined;
  const asset = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE asset_library SET name = ?, file_path = ?, category = ?, type = ?, tags = ?, source = ?, license = ?, compliance_status = ?, metadata = ?, usage_count = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    asset.name,
    asset.file_path,
    asset.category,
    asset.type,
    toJson(asset.tags),
    asset.source,
    asset.license,
    asset.compliance_status,
    toJson(asset.metadata),
    asset.usage_count,
    asset.updated_at,
    id
  );
  return asset;
}

export function deleteAsset(id: number): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM asset_library WHERE id = ?").run(id).changes > 0;
}

export function incrementUsageCount(id: number): void {
  const db = getDb();
  db.prepare("UPDATE asset_library SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}
