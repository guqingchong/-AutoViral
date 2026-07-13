/**
 * Phase 5 Comments API — comment inbox, reply suggestions, and reply management.
 * Mounted at /api/comments/.
 */

import { Hono } from "hono";
import type { DbCommentSentiment } from "../db/types.js";
import {
  listComments,
  updateComment,
  deleteComment,
} from "../db/comments-repo.js";
import {
  collectComments,
  suggestReplies,
  markReplied,
  getCommentStats,
} from "../services/comment-service.js";
import { getAdapter } from "../services/platform-adapters/registry.js";

export const commentsApi = new Hono();

// GET /api/comments
commentsApi.get("/", (c) => {
  const publishRecordId = c.req.query("publishRecordId");
  const replied = c.req.query("replied");
  const sentiment = c.req.query("sentiment");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  const comments = listComments({
    ...(publishRecordId ? { publishRecordId: parseInt(publishRecordId, 10) } : {}),
    ...(replied !== undefined && replied !== null && replied !== "" ? { replied: replied === "true" } : {}),
    ...(sentiment ? { sentiment: sentiment as any } : {}),
    limit,
  });

  return c.json({ comments });
});

// GET /api/comments/stats/:recordId
commentsApi.get("/stats/:recordId", (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const stats = getCommentStats(recordId);
  return c.json(stats);
});

// POST /api/comments/collect/:recordId
commentsApi.post("/collect/:recordId", async (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const body = await c.req.json<{ platform: string; externalId: string }>();
  if (!body.platform || !body.externalId) {
    return c.json({ error: "platform and externalId are required" }, 400);
  }
  try {
    const result = await collectComments(recordId, body.platform, body.externalId);
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// POST /api/comments/suggest/:recordId
commentsApi.post("/suggest/:recordId", async (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const body = await c.req.json<{ maxCount?: number }>().catch(() => ({ maxCount: 10 }));
  try {
    const suggestions = await suggestReplies(recordId, body.maxCount ?? 10);
    return c.json({ suggestions });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// PUT /api/comments/:id/reply
commentsApi.put("/:id/reply", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{ replyContent: string; publishToPlatform?: boolean }>();
  if (!body.replyContent) {
    return c.json({ error: "replyContent is required" }, 400);
  }

  const comment = markReplied(id, body.replyContent);
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  // Optionally publish reply to the platform
  if (body.publishToPlatform && comment.external_comment_id) {
    // We need the publish record to know which platform adapter to use
    const { getPublishRecord } = await import("../db/publish-records-repo.js");
    const record = getPublishRecord(comment.publish_record_id);
    if (record) {
      const adapter = getAdapter(record.platform);
      if (adapter) {
        const result = await adapter.publishReply(comment.external_comment_id, body.replyContent);
        if (!result.success) {
          console.warn(`[comments] Platform reply failed for comment #${id}: ${result.error}`);
        }
      }
    }
  }

  return c.json(comment);
});

// PUT /api/comments/:id
commentsApi.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{ sentiment?: string; replied?: boolean; reply_content?: string }>();
  const updated = updateComment(id, body as Partial<Omit<import("../db/types.js").DbComment, "id" | "created_at">>);
  if (!updated) return c.json({ error: "Comment not found" }, 404);
  return c.json(updated);
});

// DELETE /api/comments/:id
commentsApi.delete("/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const deleted = deleteComment(id);
  if (!deleted) return c.json({ error: "Comment not found" }, 404);
  return c.json({ deleted: true });
});
