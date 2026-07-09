import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createSnapshot } from "../../src/db/trends-repo.js";
import { createTopic, listTopics, getTopic, updateTopic } from "../../src/db/topics-repo.js";

describe("topics-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and lists topics by platform", () => {
    createSnapshot({ platform: "douyin", snapshot_date: "2026-07-08", raw_data: {} });
    createTopic({ platform: "douyin", title: "T1", heat: 5, tags: ["a"], content_angles: ["x"], status: "collected" });
    createTopic({ platform: "xiaohongshu", title: "T2", heat: 3, tags: [], content_angles: [], status: "collected" });
    const list = listTopics("douyin");
    expect(list.length).toBe(1);
    expect(list[0].title).toBe("T1");
  });

  it("updates topic status", () => {
    const t = createTopic({ platform: "douyin", title: "T", heat: 1, tags: [], content_angles: [], status: "collected" });
    const updated = updateTopic(t.id, { status: "selected" });
    expect(updated?.status).toBe("selected");
    expect(getTopic(t.id)?.status).toBe("selected");
  });
});
