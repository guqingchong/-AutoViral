import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbTopic } from "./types.js";

function rowToTopic(row: Record<string, unknown>): DbTopic {
  return {
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    snapshot_id: (row.snapshot_id as number) || undefined,
    platform: (row.platform as string) || undefined,
    title: row.title as string,
    description: (row.description as string) || undefined,
    heat: (row.heat as number) || undefined,
    competition: (row.competition as string) || undefined,
    opportunity: (row.opportunity as string) || undefined,
    emotion_type: (row.emotion_type as string) || undefined,
    emotion_subtype: (row.emotion_subtype as string) || undefined,
    tags: fromJson(row.tags as string) ?? [],
    content_angles: fromJson(row.content_angles as string) ?? [],
    example_hook: (row.example_hook as string) || undefined,
    category: (row.category as string) || undefined,
    source_url: (row.source_url as string) || undefined,
    status: row.status as DbTopic["status"],
    created_at: row.created_at as string,
  };
}

export function createTopic(topic: Omit<DbTopic, "id" | "created_at">): DbTopic {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO topics (work_id, snapshot_id, platform, title, description, heat, competition, opportunity, emotion_type, emotion_subtype, tags, content_angles, example_hook, category, source_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      topic.work_id ?? null,
      topic.snapshot_id ?? null,
      topic.platform ?? null,
      topic.title,
      topic.description ?? null,
      topic.heat ?? null,
      topic.competition ?? null,
      topic.opportunity ?? null,
      topic.emotion_type ?? null,
      topic.emotion_subtype ?? null,
      toJson(topic.tags),
      toJson(topic.content_angles),
      topic.example_hook ?? null,
      topic.category ?? null,
      topic.source_url ?? null,
      topic.status
    );
  return { ...topic, id: Number(result.lastInsertRowid), created_at: new Date().toISOString() };
}

export function listTopics(platform?: string, limit = 50): DbTopic[] {
  const db = getDb();
  const sql = platform
    ? "SELECT * FROM topics WHERE platform = ? ORDER BY heat DESC, created_at DESC LIMIT ?"
    : "SELECT * FROM topics ORDER BY heat DESC, created_at DESC LIMIT ?";
  const rows = platform
    ? (db.prepare(sql).all(platform, limit) as Record<string, unknown>[])
    : (db.prepare(sql).all(limit) as Record<string, unknown>[]);
  return rows.map(rowToTopic);
}

export function getTopic(id: number): DbTopic | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTopic(row) : undefined;
}

export function updateTopic(id: number, updates: Partial<DbTopic>): DbTopic | undefined {
  const existing = getTopic(id);
  if (!existing) return undefined;
  const topic = { ...existing, ...updates, id };
  const db = getDb();
  db.prepare(
    `UPDATE topics SET work_id = ?, snapshot_id = ?, platform = ?, title = ?, description = ?, heat = ?, competition = ?, opportunity = ?, emotion_type = ?, emotion_subtype = ?, tags = ?, content_angles = ?, example_hook = ?, category = ?, source_url = ?, status = ? WHERE id = ?`
  ).run(
    topic.work_id ?? null,
    topic.snapshot_id ?? null,
    topic.platform ?? null,
    topic.title,
    topic.description ?? null,
    topic.heat ?? null,
    topic.competition ?? null,
    topic.opportunity ?? null,
    topic.emotion_type ?? null,
    topic.emotion_subtype ?? null,
    toJson(topic.tags),
    toJson(topic.content_angles),
    topic.example_hook ?? null,
    topic.category ?? null,
    topic.source_url ?? null,
    topic.status,
    id
  );
  return topic;
}

export function deleteTopic(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM topics WHERE id = ?").run(id);
  return result.changes > 0;
}
