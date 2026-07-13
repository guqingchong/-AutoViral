import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord, listPublishRecords, updatePublishRecord } from "../../src/db/publish-records-repo.js";

describe("publish-records-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and lists publish records", () => {
    createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    createPublishRecord({ work_id: "w1", platform: "bilibili", status: "published" });
    expect(listPublishRecords({ workId: "w1" }).length).toBe(2);
    expect(listPublishRecords({ platform: "douyin" }).length).toBe(1);
  });

  it("updates status", () => {
    const r = createPublishRecord({ work_id: "w2", platform: "xiaohongshu", status: "published" });
    const updated = updatePublishRecord(r.id, { status: "failed", error_message: "风控" });
    expect(updated?.status).toBe("failed");
    expect(updated?.error_message).toBe("风控");
  });
});
