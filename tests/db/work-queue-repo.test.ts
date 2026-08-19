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

  it("终态任务重新入队分配到队尾", () => {
    repo.enqueue("w1");
    repo.setStatus("w1", "done");
    repo.enqueue("w2");
    repo.enqueue("w1");
    expect(repo.dequeueNext()?.workId).toBe("w2");
  });

  it("终态任务重新入队 + afterRunning：插在 running 之后、其他 queued 之前（打回重做主路径）", () => {
    // 真实打回流程：入队 → 执行（running）→ settle done → 人工打回 → 重入队
    repo.enqueue("w_run");
    repo.enqueue("w_done");
    repo.enqueue("w_queued");
    repo.setStatus("w_run", "running");
    repo.setStatus("w_done", "done");

    repo.enqueue("w_done", { afterRunning: true });

    const item = repo.getItem("w_done");
    expect(item?.status).toBe("queued");
    expect(repo.listQueue().map((i) => i.workId)).toEqual(["w_run", "w_done", "w_queued"]);
    expect(repo.dequeueNext()?.workId).toBe("w_done");
  });

  it("终态任务重新入队 + afterRunning 且无 running：退化为队尾", () => {
    repo.enqueue("w1");
    repo.setStatus("w1", "done");
    repo.enqueue("w2");
    repo.enqueue("w1", { afterRunning: true });
    expect(repo.listQueue().map((i) => i.workId)).toEqual(["w2", "w1"]);
  });

  // 2026-08-19 P0:paused_reason 状态机——此前 paused 有入口无出口且原因不分,三态互踩
  describe("paused_reason(暂停原因分离)", () => {
    it("setStatus paused 默认记 user 原因;离开 paused 清空", () => {
      repo.enqueue("w1");
      repo.setStatus("w1", "paused");
      expect(repo.getItem("w1")?.pausedReason).toBe("user");
      repo.setStatus("w1", "running");
      expect(repo.getItem("w1")?.pausedReason).toBeNull();
    });

    it("resumePausedByReason 只回捞指定原因,用户手动暂停不受影响", () => {
      repo.enqueue("w_quota"); repo.enqueue("w_budget"); repo.enqueue("w_user");
      repo.setStatus("w_quota", "paused", { pausedReason: "quota" });
      repo.setStatus("w_budget", "paused", { pausedReason: "budget" });
      repo.setStatus("w_user", "paused"); // 默认 user
      expect(repo.resumePausedByReason(["quota"])).toBe(1);
      expect(repo.getItem("w_quota")?.status).toBe("queued");
      expect(repo.getItem("w_budget")?.status).toBe("paused");
      expect(repo.getItem("w_user")?.status).toBe("paused");
      expect(repo.resumePausedByReason(["budget", "quota"])).toBe(1);
      expect(repo.getItem("w_user")?.status).toBe("paused"); // user 永不自动恢复
    });

    it("enqueue/prioritize 重排时清空 paused_reason", () => {
      repo.enqueue("w1");
      repo.setStatus("w1", "paused", { pausedReason: "quota" });
      repo.prioritize("w1");
      expect(repo.getItem("w1")?.pausedReason).toBeNull();
      repo.setStatus("w1", "paused", { pausedReason: "budget" });
      repo.setStatus("w1", "failed");
      repo.enqueue("w1");
      expect(repo.getItem("w1")?.pausedReason).toBeNull();
      expect(repo.getItem("w1")?.status).toBe("queued");
    });
  });
});
