import { getDb } from "./connection.js";
import type { DbComment, DbCommentSentiment } from "./types.js";

function rowToComment(row: Record<string, unknown>): DbComment {
  return {
    id: row.id as number,
    publish_record_id: row.publish_record_id as number,
    external_comment_id: (row.external_comment_id as string) || undefined,
    author_name: (row.author_name as string) || undefined,
    author_id: (row.author_id as string) || undefined,
    content: row.content as string,
    sentiment: (row.sentiment as DbCommentSentiment) || undefined,
    is_reply: Boolean(row.is_reply),
    parent_external_id: (row.parent_external_id as string) || undefined,
    replied: Boolean(row.replied),
    reply_content: (row.reply_content as string) || undefined,
    reply_published_at: (row.reply_published_at as string) || undefined,
    collected_at: row.collected_at as string,
    created_at: row.created_at as string,
  };
}

export function createComment(
  comment: Omit<DbComment, "id" | "created_at">
): DbComment {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO comments (publish_record_id, external_comment_id, author_name, author_id, content, sentiment, is_reply, parent_external_id, replied, reply_content, reply_published_at, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      comment.publish_record_id,
      comment.external_comment_id ?? null,
      comment.author_name ?? null,
      comment.author_id ?? null,
      comment.content,
      comment.sentiment ?? null,
      comment.is_reply ? 1 : 0,
      comment.parent_external_id ?? null,
      comment.replied ? 1 : 0,
      comment.reply_content ?? null,
      comment.reply_published_at ?? null,
      comment.collected_at
    );
  return { ...comment, id: Number(result.lastInsertRowid), created_at: new Date().toISOString() };
}

export function listComments(filters?: {
  publishRecordId?: number;
  replied?: boolean;
  sentiment?: DbCommentSentiment;
  limit?: number;
}): DbComment[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters?.publishRecordId !== undefined) {
    conditions.push("publish_record_id = ?");
    params.push(filters.publishRecordId);
  }
  if (filters?.replied !== undefined) {
    conditions.push("replied = ?");
    params.push(filters.replied ? 1 : 0);
  }
  if (filters?.sentiment) {
    conditions.push("sentiment = ?");
    params.push(filters.sentiment);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters?.limit ?? 100, 500);
  const rows = db
    .prepare(`SELECT * FROM comments ${where} ORDER BY collected_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToComment);
}

export function updateComment(
  id: number,
  updates: Partial<Omit<DbComment, "id" | "created_at">>
): DbComment | undefined {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM comments WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return undefined;
  const comment = { ...rowToComment(existing), ...updates };
  db.prepare(
    `UPDATE comments SET
      replied = ?, reply_content = ?, reply_published_at = ?, sentiment = ?
     WHERE id = ?`
  ).run(
    comment.replied ? 1 : 0,
    comment.reply_content ?? null,
    comment.reply_published_at ?? null,
    comment.sentiment ?? null,
    id
  );
  return comment;
}

export function deleteComment(id: number): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM comments WHERE id = ?").run(id).changes > 0;
}
