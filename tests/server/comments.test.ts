import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createComment } from "../../src/db/comments-repo.js";
import { commentsRoutes } from "../../src/server/routes/comments.js";
import type { DbWork } from "../../src/db/types.js";

function setupApp() {
  const app = new Hono();
  app.route("/api/comments", commentsRoutes);
  return app;
}

function sampleWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: overrides.id ?? "w_comment_test",
    title: overrides.title ?? "评论测试",
    type: "short-video",
    status: "published",
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("comments routes", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("lists comments", async () => {
    createWork(sampleWork({ id: "w_comment1" }), []);
    const record = createPublishRecord({ work_id: "w_comment1", platform: "douyin", status: "published" });
    createComment({
      publish_record_id: record.id,
      content: "你好",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    const res = await setupApp().request("/api/comments");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
  });

  it("lists comments empty when no data", async () => {
    const res = await setupApp().request("/api/comments");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it("filters comments by keyword", async () => {
    createWork(sampleWork({ id: "w_keyword" }), []);
    const record = createPublishRecord({ work_id: "w_keyword", platform: "douyin", status: "published" });
    createComment({
      publish_record_id: record.id,
      content: "怎么购买？",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    createComment({
      publish_record_id: record.id,
      content: "太棒了！",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    const res = await setupApp().request("/api/comments?keyword=购买");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].content).toBe("怎么购买？");
  });

  it("filters unreplied comments", async () => {
    createWork(sampleWork({ id: "w_unreplied" }), []);
    const record = createPublishRecord({ work_id: "w_unreplied", platform: "douyin", status: "published" });
    createComment({
      publish_record_id: record.id,
      content: "未回复",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    createComment({
      publish_record_id: record.id,
      content: "已回复",
      is_reply: false,
      replied: true,
      collected_at: new Date().toISOString(),
    });
    const res = await setupApp().request("/api/comments?replied=false");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].content).toBe("未回复");
  });

  it("classifies comments", async () => {
    createWork(sampleWork({ id: "w_classify" }), []);
    const record = createPublishRecord({ work_id: "w_classify", platform: "douyin", status: "published" });
    createComment({
      publish_record_id: record.id,
      content: "怎么买",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    const res = await setupApp().request("/api/comments/classify", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.classified).toBe(1);
  });

  it("returns 404 for reply suggestions on missing comment", async () => {
    const res = await setupApp().request("/api/comments/99999/reply-suggest", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("rejects reply with empty content", async () => {
    createWork(sampleWork({ id: "w_reply" }), []);
    const record = createPublishRecord({ work_id: "w_reply", platform: "douyin", status: "published" });
    const comment = createComment({
      publish_record_id: record.id,
      content: "不错",
      is_reply: false,
      replied: false,
      collected_at: new Date().toISOString(),
    });
    const res = await setupApp().request(`/api/comments/${comment.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });
});
