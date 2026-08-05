import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as repo from "../../src/db/work-queue-repo.js";

describe("work-queue-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("enqueue 分配递增 position，dequeueNext 取最小 position 的 queued", () => {
    repo.enqueue("w1"); repo.enqueue("w2"); repo.enqueue("w3");
    expect(repo.dequeueNext()?.workId).toBe("w1");
  });

  it("paused 的任务被 dequeueNext 跳过", () => {
    repo.enqueue("w1"); repo.enqueue("w2");
    repo.setStatus("w1", "paused");
    expect(repo.dequeueNext()?.workId).toBe("w2");
  });

  it("prioritize 移到 running 之后第一位", () => {
    repo.enqueue("w1"); repo.enqueue("w2"); repo.enqueue("w3");
    repo.setStatus("w1", "running");
    repo.prioritize("w3");
    expect(repo.dequeueNext()?.workId).toBe("w3");
  });

  it("重复入队同一作品不重复（幂等）", () => {
    repo.enqueue("w1"); repo.enqueue("w1");
    expect(repo.listQueue().filter(i => i.workId === "w1")).toHaveLength(1);
  });
});
