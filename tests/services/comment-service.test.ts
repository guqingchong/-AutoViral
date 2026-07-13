import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { collectComments, suggestReplies, markReplied, getCommentStats } from "../../src/services/comment-service.js";
import { registerAdapter, clearRegistry } from "../../src/services/platform-adapters/registry.js";
import type { PlatformAdapter, CollectedMetrics, CollectedComment, ReplyResult } from "../../src/services/platform-adapters/types.js";
import * as llmJson from "../../src/services/llm-json.js";

class MockCommentAdapter implements PlatformAdapter {
  readonly platform = "mock";
  readonly label = "Mock";

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    return { followers: 0, collectedAt: new Date().toISOString(), rawData: {} };
  }

  async collectPostMetrics(): Promise<CollectedMetrics> {
    return { views: 0, collectedAt: new Date().toISOString(), rawData: {} };
  }

  async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    return {
      comments: [
        {
          externalCommentId: "c1",
          authorName: "User1",
          content: "太棒了！怎么买？",
          isReply: false,
          collectedAt: new Date().toISOString(),
        },
        {
          externalCommentId: "c2",
          authorName: "User2",
          content: "不好看",
          isReply: false,
          collectedAt: new Date().toISOString(),
        },
      ],
    };
  }

  async publishReply(): Promise<ReplyResult> {
    return { success: true };
  }
}

describe("comment-service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    clearRegistry();
    registerAdapter(new MockCommentAdapter());
  });

  afterEach(() => {
    closeDb();
    clearRegistry();
  });

  it("collects comments with sentiment", async () => {
    const record = createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });
    const result = await collectComments(record.id, "mock", "p1");
    expect(result.newCount).toBe(2);
    expect(result.totalCount).toBe(2);

    const stats = getCommentStats(record.id);
    expect(stats.total).toBe(2);
    expect(stats.question).toBe(1);
    expect(stats.negative).toBe(1);
  });

  it("deduplicates by external_comment_id", async () => {
    const record = createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });
    await collectComments(record.id, "mock", "p1");
    const result = await collectComments(record.id, "mock", "p1");
    expect(result.newCount).toBe(0);
    expect(result.totalCount).toBe(2);
  });

  it("suggests replies for unreplied comments", async () => {
    vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
      replies: [
        { index: 1, text: "感谢支持，私信发你链接" },
        { index: 2, text: "抱歉没让你满意" },
      ],
    });

    const record = createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });
    await collectComments(record.id, "mock", "p1");
    const suggestions = await suggestReplies(record.id);
    expect(suggestions.length).toBe(2);
  });

  it("marks a comment as replied", async () => {
    const record = createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });
    await collectComments(record.id, "mock", "p1");
    const updated = markReplied(1, "私信你");
    expect(updated?.replied).toBe(true);
    expect(updated?.reply_content).toBe("私信你");
  });
});
