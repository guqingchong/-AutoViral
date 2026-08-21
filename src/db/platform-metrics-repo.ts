import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";
import type { DbPlatformMetric, DbMetricType } from "./types.js";

function rowToMetric(row: Record<string, unknown>): DbPlatformMetric {
  return {
    id: row.id as number,
    publish_record_id: (row.publish_record_id as number) || undefined,
    platform: row.platform as string,
    account_id: (row.account_id as string) || undefined,
    metric_type: row.metric_type as DbMetricType,
    external_id: (row.external_id as string) || undefined,
    collected_at: row.collected_at as string,
    views: (row.views as number) || undefined,
    likes: (row.likes as number) || undefined,
    comments: (row.comments as number) || undefined,
    shares: (row.shares as number) || undefined,
    collects: (row.collects as number) || undefined,
    completion_rate: (row.completion_rate as number) || undefined,
    followers: (row.followers as number) || undefined,
    raw_data: fromJson(row.raw_data as string) as Record<string, unknown>,
  };
}

export function createMetric(metric: Omit<DbPlatformMetric, "id">): DbPlatformMetric {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO platform_metrics (publish_record_id, platform, account_id, metric_type, external_id, collected_at, views, likes, comments, shares, collects, completion_rate, followers, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      metric.publish_record_id ?? null,
      metric.platform,
      metric.account_id ?? null,
      metric.metric_type,
      metric.external_id ?? null,
      metric.collected_at,
      metric.views ?? null,
      metric.likes ?? null,
      metric.comments ?? null,
      metric.shares ?? null,
      metric.collects ?? null,
      metric.completion_rate ?? null,
      metric.followers ?? null,
      toJson(metric.raw_data)
    );
  return { ...metric, id: Number(result.lastInsertRowid) };
}

export function getLatestMetricByRecord(publishRecordId: number): DbPlatformMetric | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM platform_metrics WHERE publish_record_id = ? ORDER BY collected_at DESC LIMIT 1")
    .get(publishRecordId) as Record<string, unknown> | undefined;
  return row ? rowToMetric(row) : undefined;
}

export function listMetricsByRecord(publishRecordId: number, limit = 30): DbPlatformMetric[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM platform_metrics WHERE publish_record_id = ? ORDER BY collected_at DESC LIMIT ?")
    .all(publishRecordId, limit) as Record<string, unknown>[];
  return rows.map(rowToMetric);
}

export function listLatestWorkMetrics(filters?: {
  platform?: string;
  limit?: number;
}): DbPlatformMetric[] {
  const db = getDb();
  const platformClause = filters?.platform ? "WHERE m.platform = ?" : "";
  const params: unknown[] = filters?.platform
    ? [filters.platform, filters?.limit ?? 100]
    : [filters?.limit ?? 100];
  const rows = db
    .prepare(
      `SELECT m.* FROM platform_metrics m
       INNER JOIN (
         SELECT publish_record_id, MAX(collected_at) AS max_collected
         FROM platform_metrics
         WHERE metric_type = 'work'
         GROUP BY publish_record_id
       ) latest ON m.publish_record_id = latest.publish_record_id AND m.collected_at = latest.max_collected
       ${platformClause}
       ORDER BY m.collected_at DESC
       LIMIT ?`
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToMetric);
}

export function getLatestAccountMetric(platform: string): DbPlatformMetric | undefined {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM platform_metrics WHERE platform = ? AND metric_type = 'account' ORDER BY collected_at DESC LIMIT 1"
    )
    .get(platform) as Record<string, unknown> | undefined;
  return row ? rowToMetric(row) : undefined;
}
