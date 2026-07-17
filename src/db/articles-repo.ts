import { getDb } from "./connection.js";
import type { DbArticle } from "./types.js";

export function createArticle(article: Omit<DbArticle, "id" | "created_at">): DbArticle {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO articles (work_id, topic_id, title, content, platform, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      article.work_id ?? null,
      article.topic_id ?? null,
      article.title,
      article.content,
      article.platform ?? null,
      article.status
    );
  return { ...article, id: Number(result.lastInsertRowid), created_at: new Date().toISOString() };
}

export function getArticle(id: number): DbArticle | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM articles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    topic_id: (row.topic_id as number) || undefined,
    title: row.title as string,
    content: row.content as string,
    platform: (row.platform as string) || undefined,
    status: row.status as DbArticle["status"],
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) || undefined,
  };
}

export function listArticlesByWork(workId: string): DbArticle[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM articles WHERE work_id = ? ORDER BY created_at DESC").all(workId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    topic_id: (row.topic_id as number) || undefined,
    title: row.title as string,
    content: row.content as string,
    platform: (row.platform as string) || undefined,
    status: row.status as DbArticle["status"],
    created_at: row.created_at as string,
  }));
}


export function updateArticle(id: number, updates: Partial<DbArticle>): DbArticle | undefined {
  const db = getDb();
  const existing = getArticle(id);
  if (!existing) return undefined;
  const article = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE articles SET title = ?, content = ?, platform = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(
    article.title,
    article.content,
    article.platform ?? null,
    article.status,
    article.updated_at,
    id
  );
  return article;
}

export function listAllArticles(limit = 100): DbArticle[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM articles ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as number,
    work_id: (row.work_id as string) || undefined,
    topic_id: (row.topic_id as number) || undefined,
    title: row.title as string,
    content: row.content as string,
    platform: (row.platform as string) || undefined,
    status: row.status as DbArticle["status"],
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) || undefined,
  }));
}
