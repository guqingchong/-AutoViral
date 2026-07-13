/**
 * Comment management service.
 *
 * Orchestrates: collecting comments → classifying sentiment → suggesting replies.
 * Delegates to platform adapters for collection and Claude CLI for reply generation.
 */

import { getAdapter } from "./platform-adapters/registry.js";
import { createComment, listComments, updateComment } from "../db/comments-repo.js";
import { classifySentiment } from "./sentiment-helper.js";
import { runJsonPrompt } from "./llm-json.js";
import type { DbComment } from "../db/types.js";

export interface CollectResult {
  newCount: number;
  totalCount: number;
}

/**
 * Collect comments for a publish record and store them in the DB.
 * Skips comments whose external_comment_id already exists for this record.
 */
export async function collectComments(
  publishRecordId: number,
  platform: string,
  externalId: string
): Promise<CollectResult> {
  const adapter = getAdapter(platform);
  if (!adapter) throw new Error(`No adapter registered for platform: ${platform}`);

  let newCount = 0;
  let cursor: string | undefined;
  const existingIds = new Set(
    listComments({ publishRecordId, limit: 500 })
      .map((c) => c.external_comment_id)
      .filter((id): id is string => !!id)
  );

  do {
    const page = await adapter.collectComments(externalId, cursor);
    for (const c of page.comments) {
      if (c.externalCommentId && existingIds.has(c.externalCommentId)) continue;
      await createComment({
        publish_record_id: publishRecordId,
        external_comment_id: c.externalCommentId,
        author_name: c.authorName,
        author_id: c.authorId,
        content: c.content,
        sentiment: classifySentiment(c.content),
        is_reply: c.isReply,
        parent_external_id: c.parentExternalId,
        replied: false,
        collected_at: c.collectedAt,
      });
      if (c.externalCommentId) existingIds.add(c.externalCommentId);
      newCount++;
    }
    cursor = page.nextCursor;
  } while (cursor);

  const all = listComments({ publishRecordId });

  return { newCount, totalCount: all.length };
}

export interface ReplySuggestion {
  commentId: number;
  content: string;
  suggestion: string;
}

/**
 * Generate AI reply suggestions for un-replied comments.
 * Uses Claude CLI via runJsonPrompt.
 */
export async function suggestReplies(
  publishRecordId: number,
  maxCount = 10
): Promise<ReplySuggestion[]> {
  const unReplied = listComments({
    publishRecordId,
    replied: false,
    limit: maxCount,
  }).filter((c) => !c.is_reply); // Don't suggest replies to replies

  if (unReplied.length === 0) return [];

  const commentList = unReplied
    .map((c, i) => `${i + 1}. [${c.sentiment}] ${c.author_name ?? "用户"}: ${c.content}`)
    .join("\n");

  const prompt = [
    "你是一个社交媒体运营助手。以下是你发布的视频/文章收到的评论。",
    "为每条评论生成一个友好、得体的中文回复。",
    "回复要简短（30字以内），体现真诚互动。",
    "对于负面评论，保持礼貌和建设性。",
    "对于提问，给出有帮助的回答。",
    "",
    commentList,
    "",
    `输出 JSON：{"replies":[{"index": 1, "text":"回复内容"}, ...]}`,
  ].join("\n");

  const result = await runJsonPrompt<{
    replies: Array<{ index: number; text: string }>;
  }>(prompt, { timeoutMs: 120_000 });

  return (result.replies ?? [])
    .filter((r) => r.index > 0 && r.index <= unReplied.length)
    .map((r) => ({
      commentId: unReplied[r.index - 1].id,
      content: unReplied[r.index - 1].content,
      suggestion: r.text,
    }));
}

/**
 * Mark a comment as replied with the given reply content.
 */
export function markReplied(commentId: number, replyContent: string): DbComment | undefined {
  return updateComment(commentId, {
    replied: true,
    reply_content: replyContent,
    reply_published_at: new Date().toISOString(),
  });
}

/**
 * Get comment statistics for a publish record.
 */
export function getCommentStats(publishRecordId: number) {
  const all = listComments({ publishRecordId });
  const replied = all.filter((c) => c.replied).length;
  return {
    total: all.length,
    replied,
    unreplied: all.length - replied,
    positive: all.filter((c) => c.sentiment === "positive").length,
    negative: all.filter((c) => c.sentiment === "negative").length,
    neutral: all.filter((c) => c.sentiment === "neutral").length,
    question: all.filter((c) => c.sentiment === "question").length,
  };
}
