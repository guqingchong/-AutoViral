import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as repo from "../../src/db/work-queue-repo.js";
import { getWork } from "../../src/work-store.js";
import type { WorkStatus } from "../../src/work-store.js";

vi.mock("../../src/work-store.js", () => ({ getWork: vi.fn() }));

import {
  initWorkQueue,
  enqueueWork,
  notifyWorkSettled,
  kickRunner,
  startRunner,
  stopRunner,
  _whenIdle,
  _resetRunner,
} from "../../src/services/work-queue.js";

const mockGetWork = vi.mocked(getWork);

describe("work-queue runner", () => {
  const workStatuses = new Map<string, WorkStatus>();
  const aliveSessions = new Set<string>();
  const startWork = vi.fn<(workId: string) => Promise<unknown>>();
  const isSessionAlive = vi.fn((workId: string) => aliveSessions.has(workId));

  beforeEach(() => {
    _resetRunner();
    resetInMemoryDb();
    migrate();
    workStatuses.clear();
    aliveSessions.clear();
    startWork.mockReset().mockResolvedValue(undefined);
    isSessionAlive.mockClear();
    mockGetWork.mockImplementation(async (id: string) => {
      const status = workStatuses.get(id);
      if (!status) return undefined;
      return { id, status } as Awaited<ReturnType<typeof getWork>>;
    });
    initWorkQueue({ startWork, isSessionAlive });
  });

  afterEach(() => {
    _resetRunner();
    closeDb();
  });

  it("队列空时 runner 不启动任何作品", async () => {
    kickRunner();
    await _whenIdle();
    expect(startWork).not.toHaveBeenCalled();
  });

  it("startRunner 立即跑一次调度，stopRunner 停止轮询", async () => {
    startRunner();
    await _whenIdle();
    expect(startWork).not.toHaveBeenCalled();
    stopRunner();
  });

  it("enqueue 两个作品 → 串行只启动第一个；会话存活时不重复启动", async () => {
    workStatuses.set("w1", "researching");
    workStatuses.set("w2", "draft");

    enqueueWork("w1");
    await _whenIdle();
    expect(startWork).toHaveBeenCalledTimes(1);
    expect(startWork).toHaveBeenLastCalledWith("w1");
    expect(repo.getItem("w1")?.status).toBe("running");
    expect(repo.getItem("w2")).toBeUndefined();

    // w1 会话存活：再入队 w2 并唤醒，不应重复启动 w1，也不应启动 w2
    aliveSessions.add("w1");
    enqueueWork("w2");
    await _whenIdle();
    expect(startWork).toHaveBeenCalledTimes(1);
    expect(repo.getItem("w2")?.status).toBe("queued");
  });

  it("notifyWorkSettled(reviewing) → 当前任务标 done，自动启动下一个", async () => {
    workStatuses.set("w1", "researching");
    workStatuses.set("w2", "draft");
    aliveSessions.add("w1");

    enqueueWork("w1");
    enqueueWork("w2");
    await _whenIdle();
    expect(startWork).toHaveBeenCalledTimes(1);

    workStatuses.set("w1", "reviewing");
    notifyWorkSettled("w1", "reviewing");
    await _whenIdle();

    expect(repo.getItem("w1")?.status).toBe("done");
    expect(startWork).toHaveBeenCalledTimes(2);
    expect(startWork).toHaveBeenLastCalledWith("w2");
    expect(repo.getItem("w2")?.status).toBe("running");
  });

  it("notifyWorkSettled(failed) → 当前任务标 failed，自动启动下一个", async () => {
    workStatuses.set("w1", "assembling");
    workStatuses.set("w2", "draft");
    aliveSessions.add("w1");

    enqueueWork("w1");
    enqueueWork("w2");
    await _whenIdle();

    workStatuses.set("w1", "failed");
    notifyWorkSettled("w1", "failed");
    await _whenIdle();

    expect(repo.getItem("w1")?.status).toBe("failed");
    expect(repo.getItem("w2")?.status).toBe("running");
    expect(startWork).toHaveBeenLastCalledWith("w2");
  });

  it("paused 作品被跳过，启动其后的 queued 作品", async () => {
    workStatuses.set("w1", "researching");
    workStatuses.set("w2", "draft");
    repo.enqueue("w1");
    repo.enqueue("w2");
    repo.setStatus("w1", "paused");

    kickRunner();
    await _whenIdle();

    expect(startWork).toHaveBeenCalledTimes(1);
    expect(startWork).toHaveBeenLastCalledWith("w2");
    expect(repo.getItem("w1")?.status).toBe("paused");
    expect(repo.getItem("w2")?.status).toBe("running");
  });

  it("running 作品处于中间状态（assetting）但会话死亡 → 调 startWork 恢复", async () => {
    workStatuses.set("w1", "assetting");
    repo.enqueue("w1");
    repo.setStatus("w1", "running");

    kickRunner();
    await _whenIdle();

    expect(startWork).toHaveBeenCalledTimes(1);
    expect(startWork).toHaveBeenLastCalledWith("w1");
    expect(repo.getItem("w1")?.status).toBe("running");
    expect(repo.getItem("w1")?.resumeAttempts).toBe(1);
  });

  it("恢复次数超过上限（5）→ 标记 failed，不再调 startWork，继续启动下一个", async () => {
    workStatuses.set("w1", "assetting");
    workStatuses.set("w2", "draft");
    repo.enqueue("w1");
    repo.enqueue("w2");
    repo.setStatus("w1", "running");
    for (let i = 0; i < 5; i++) repo.incrementResumeAttempts("w1");

    kickRunner();
    await _whenIdle();

    expect(repo.getItem("w1")?.status).toBe("failed");
    expect(startWork).toHaveBeenCalledTimes(1);
    expect(startWork).toHaveBeenLastCalledWith("w2");
  });

  it("running 作品已消失（getWork 返回 undefined）→ 标记 failed", async () => {
    repo.enqueue("w1");
    repo.setStatus("w1", "running");
    workStatuses.set("w2", "draft");
    repo.enqueue("w2");

    kickRunner();
    await _whenIdle();

    expect(repo.getItem("w1")?.status).toBe("failed");
    expect(startWork).toHaveBeenCalledTimes(1);
    expect(startWork).toHaveBeenLastCalledWith("w2");
  });

  it("running 作品已到 reviewing/published 但漏了 notify → 健康检查兜底标 done", async () => {
    workStatuses.set("w1", "reviewing");
    workStatuses.set("w2", "draft");
    repo.enqueue("w1");
    repo.setStatus("w1", "running");
    repo.enqueue("w2");

    kickRunner();
    await _whenIdle();

    expect(repo.getItem("w1")?.status).toBe("done");
    expect(startWork).toHaveBeenCalledWith("w2");
  });

  it("startWork 抛错被吞掉，不中断调度", async () => {
    workStatuses.set("w1", "draft");
    startWork.mockRejectedValueOnce(new Error("session spawn failed"));

    enqueueWork("w1");
    await _whenIdle();

    expect(startWork).toHaveBeenCalledTimes(1);
    expect(repo.getItem("w1")?.status).toBe("running");
  });

  it("notifyWorkSettled 对非 running 任务不改状态，仅唤醒", async () => {
    workStatuses.set("w1", "draft");
    repo.enqueue("w1");

    notifyWorkSettled("w1", "reviewing");
    await _whenIdle();

    // w1 仍是 queued → 被正常启动，而非标 done
    expect(repo.getItem("w1")?.status).toBe("running");
    expect(startWork).toHaveBeenCalledWith("w1");
  });
});
