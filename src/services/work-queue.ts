// Work queue runner — 严格串行执行作品流水线会话。
// 同一时刻最多一个 running 作品；会话死亡时按 resumeAttempts 上限恢复。
// 不直接 import api.ts（避免循环依赖），会话能力通过 initWorkQueue 依赖注入。

import * as repo from "../db/work-queue-repo.js";
import { getWork } from "../work-store.js";

/** 会话恢复上限：超过后标记 failed，不再自动恢复 */
const MAX_RESUME_ATTEMPTS = 5;
/** 轮询间隔（毫秒）；kickRunner 提供即时唤醒，轮询仅作兜底 */
const POLL_INTERVAL_MS = 30_000;

export interface RunnerDeps {
  startWork: (workId: string) => Promise<unknown>;
  isSessionAlive: (workId: string) => boolean;
}

let deps: RunnerDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let inflight: Promise<void> = Promise.resolve();

export function initWorkQueue(d: RunnerDeps): void {
  deps = d;
}

/** 将一次调度追加到 Promise 链尾，保证 kick 不丢失、可等待 */
function launchTick(): void {
  inflight = inflight.then(() => tick()).catch(() => {});
}

/** 入队并立即唤醒 runner（不等 30s 轮询） */
export function enqueueWork(workId: string, opts: { afterRunning?: boolean } = {}): void {
  repo.enqueue(workId, opts);
  kickRunner();
}

/** 作品流水线 advance/reject 时调用：驱动出队并启动下一个 */
export function notifyWorkSettled(workId: string, status: "reviewing" | "failed"): void {
  const item = repo.getItem(workId);
  if (item?.status === "running") {
    repo.setStatus(workId, status === "reviewing" ? "done" : "failed");
  }
  kickRunner();
}

/** 立即唤醒 runner 执行一次调度 */
export function kickRunner(): void {
  launchTick();
}

export function startRunner(): void {
  if (timer) return;
  timer = setInterval(launchTick, POLL_INTERVAL_MS);
  launchTick();
}

export function stopRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 测试用：等待调度链上所有已触发的 tick 完成 */
export function _whenIdle(): Promise<void> {
  return inflight;
}

/** 测试/关闭用：重置内部状态 */
export function _resetRunner(): void {
  stopRunner();
  ticking = false;
  inflight = Promise.resolve();
  deps = null;
}

async function tick(): Promise<void> {
  if (!deps || ticking) return;
  ticking = true;
  try {
    await tickOnce(deps);
  } finally {
    ticking = false;
  }
}

async function tickOnce(d: RunnerDeps): Promise<void> {
  // 1. running 任务健康检查：会话死了且作品仍在中间状态 → 恢复
  const running = repo.listQueue().filter((i) => i.status === "running");
  for (const item of running) {
    const work = await getWork(item.workId);
    if (!work) {
      repo.setStatus(item.workId, "failed");
      continue;
    }
    if (work.status === "reviewing" || work.status === "published") {
      repo.setStatus(item.workId, "done");
      continue;
    }
    if (work.status === "failed") {
      repo.setStatus(item.workId, "failed");
      continue;
    }
    if (!d.isSessionAlive(item.workId)) {
      const attempts = repo.incrementResumeAttempts(item.workId);
      if (attempts > MAX_RESUME_ATTEMPTS) {
        repo.setStatus(item.workId, "failed");
        continue;
      }
      await d.startWork(item.workId).catch(() => {});
    }
    return; // 有 running 任务，严格串行：不启动新任务
  }
  // 2. 启动下一个 queued（paused 由 repo.dequeueNext 天然跳过）
  const next = repo.dequeueNext();
  if (!next) return;
  repo.setStatus(next.workId, "running");
  repo.incrementResumeAttempts(next.workId);
  await d.startWork(next.workId).catch(() => {});
}
