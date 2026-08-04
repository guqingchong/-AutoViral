import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbVoice } from "./types.js";

function rowToVoice(row: Record<string, unknown>): DbVoice {
  return {
    id: row.id as string,
    name: row.name as string,
    voice_id: row.voice_id as string,
    type: row.type as DbVoice["type"],
    status: row.status as DbVoice["status"],
    source_file_path: (row.source_file_path as string) || undefined,
    demo_audio_path: (row.demo_audio_path as string) || undefined,
    error: (row.error as string) || undefined,
    metadata: fromJson(row.metadata as string) ?? {},
    usage_count: (row.usage_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createVoice(voice: DbVoice): DbVoice {
  const db = getDb();
  db.prepare(
    `INSERT INTO voices (id, name, voice_id, type, status, source_file_path, demo_audio_path, error, metadata, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    voice.id, voice.name, voice.voice_id, voice.type, voice.status,
    voice.source_file_path ?? null, voice.demo_audio_path ?? null, voice.error ?? null,
    toJson(voice.metadata), voice.usage_count, voice.created_at, voice.updated_at
  );
  return voice;
}

export function getVoice(id: string): DbVoice | undefined {
  const row = getDb().prepare("SELECT * FROM voices WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToVoice(row) : undefined;
}

export function getVoiceByVoiceId(voiceId: string): DbVoice | undefined {
  const row = getDb().prepare("SELECT * FROM voices WHERE voice_id = ?").get(voiceId) as Record<string, unknown> | undefined;
  return row ? rowToVoice(row) : undefined;
}

export function listVoices(): DbVoice[] {
  const rows = getDb().prepare("SELECT * FROM voices ORDER BY updated_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToVoice);
}

export function updateVoice(id: string, updates: Partial<DbVoice>): DbVoice | undefined {
  const db = getDb();
  const existing = getVoice(id);
  if (!existing) return undefined;
  const voice = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE voices SET name = ?, voice_id = ?, type = ?, status = ?, source_file_path = ?, demo_audio_path = ?, error = ?, metadata = ?, usage_count = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    voice.name, voice.voice_id, voice.type, voice.status,
    voice.source_file_path ?? null, voice.demo_audio_path ?? null, voice.error ?? null,
    toJson(voice.metadata), voice.usage_count, voice.updated_at, id
  );
  return voice;
}

export function deleteVoice(id: string): boolean {
  return getDb().prepare("DELETE FROM voices WHERE id = ?").run(id).changes > 0;
}

export function incrementVoiceUsage(id: string): void {
  getDb().prepare("UPDATE voices SET usage_count = usage_count + 1 WHERE id = ?").run(id);
}
