import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createComment, listComments, updateComment } from "../../src/db/comments-repo.js";

describe("comments-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and filters comments", () => {
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    createComment({ publish_record_id: record.id, content: "不错", sentiment: "positive", is_reply: false, replied: false, collected_at: new Date().toISOString() });
    createComment({ publish_record_id: record.id, content: "垃圾", sentiment: "negative", is_reply: false, replied: false, collected_at: new Date().toISOString() });
    expect(listComments({ publishRecordId: record.id }).length).toBe(2);
    expect(listComments({ publishRecordId: record.id, sentiment: "positive" }).length).toBe(1);
  });

  it("updates reply", () => {
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    const c = createComment({ publish_record_id: record.id, content: "怎么买", sentiment: "question", is_reply: false, replied: false, collected_at: new Date().toISOString() });
    const updated = updateComment(c.id, { replied: true, reply_content: "私信你" });
    expect(updated?.replied).toBe(true);
    expect(updated?.reply_content).toBe("私信你");
  });
});
