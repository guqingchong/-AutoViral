// Work queue runner — 严格串行执行作品流水线会话。
// 同一时刻最多一个 running 作品；会话死亡时按 resumeAttempts 上限恢复。
// 不直接 import api.ts（避免循环依赖），会话能力通过 initWorkQueue 依赖注入。

import * as repo from "../db/work-queue-repo.js";
import { getWork } from "../work-store.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { quotaState, quotaAllowsStart } from "./quota-guard.js";
import { broadcastProgress } from "./progress-events.js";
import { loadConfig } from "../config.js";
import { getDailyCostYuan } from "./llm-usage.js";

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
  // 0. A3 配额防护:LLM 配额冷却期 —— running 项置 paused(不 incrementResumeAttempts,
  // 配额不是作品的问题不计恢复次数);到试探窗口恢复一项单次试探,成败由
  // reportQuotaExhausted/reportQuotaSuccess 回写(指数回退 30→60→120→240min)。
  if (quotaState().exhausted) {
    const running = repo.listQueue().filter((i) => i.status === "running");
    if (!quotaAllowsStart()) {
      for (const item of running) repo.setStatus(item.workId, "paused", { pausedReason: "quota" });
      if (running.length) {
        console.log(`[work-queue] 配额冷却:${running.length} 个 running 项置 paused`);
        // 批次4.6:配额冷却全局通知(此前仅 console.log,UI 无感知)
        broadcastProgress({ kind: "system", text: `LLM 配额冷却中,${running.length} 个作品已自动暂停;恢复试探将按指数回退自动进行` });
      }
      return;
    }
    // 试探只挑配额暂停的项——用户手动暂停(user)/预算熔断(budget)的绝不被误拉起(2026-08-19 P0)
    const probe = running[0] ?? repo.listQueue().find((i) => i.status === "paused" && i.pausedReason === "quota");
    if (!probe) return; // 无在途项可试探;queued 项待试探成功后再启动
    console.log(`[work-queue] 配额试探窗口:恢复 ${probe.workId} 单次试探`);
    repo.setStatus(probe.workId, "running");
    await d.startWork(probe.workId).catch(() => {});
    return;
  }

  // 0.5 paused 出口(2026-08-19 P0:此前配额/熔断恢复后 paused 项永久滞留):
  // 配额已解除(上方分支未进入)→ 批量回捞 quota 暂停项;日预算已回落 → 回捞 budget 项。
  // 用户手动暂停(user)不在此列,只能手动恢复。
  {
    const quotaResumed = repo.resumePausedByReason(["quota"]);
    if (quotaResumed) console.log(`[work-queue] 配额已恢复:${quotaResumed} 个 paused 项回 queued`);
    try {
      const cfg = await loadConfig();
      const limit = cfg.budget?.dailyLimitYuan;
      if (limit && getDailyCostYuan() < limit) {
        const budgetResumed = repo.resumePausedByReason(["budget"]);
        if (budgetResumed) console.log(`[work-queue] 预算已回落:${budgetResumed} 个 paused 项回 queued`);
      }
    } catch { /* 配置/记账读取失败不阻断调度 */ }
  }

  // 1. running 任务健康检查：会话死了且作品仍在中间状态 → 恢复
  const running = repo.listQueue().filter((i) => i.status === "running");
  for (const item of running) {
    const work = await getWork(item.workId);
    if (!work) {
      repo.setStatus(item.workId, "failed");
      continue;
    }
    if (work.status === "reviewing" || work.status === "approved" || work.status === "published") {
      repo.setStatus(item.workId, "done");
      continue;
    }
    if (work.status === "failed") {
      repo.setStatus(item.workId, "failed");
      continue;
    }
    if (!d.isSessionAlive(item.workId)) {
      // 成片已存在且流水线已全 finish 时不 resume：作品实际已完成只是未上报,
      // 交给 reconcile(每 60s)修复状态,避免对已完成的作坊重复渲染(2026-08-06 根因)。
      // 2026-08-16 修正：必须同时检查流水线完成度——final.mp4 存在但阶段未走完
      // (如 d34 成片出了但 QC/发布文案/推进未做、f2c 返工中)时继续闷头 skip
      // 会让作品永远卡在 running 悬空态。
      if (hasFinalOutput(item.workId) && allStepsFinished(work)) continue;
      const attempts = repo.incrementResumeAttempts(item.workId);
      if (attempts > MAX_RESUME_ATTEMPTS) {
        repo.setStatus(item.workId, "failed");
        continue;
      }
      // 2026-08-19 P1:恢复失败留痕(此前静默吞错,排障只能靠推断)
      await d.startWork(item.workId).catch((err) => {
        console.warn(`[work-queue] resume ${item.workId} 启动失败(第 ${attempts} 次):`, err instanceof Error ? err.message : err);
      });
    }
    return; // 有 running 任务，严格串行：不启动新任务
  }
  // 2. 启动下一个 queued（paused 由 repo.dequeueNext 天然跳过）
  const next = repo.dequeueNext();
  if (!next) return;
  repo.setStatus(next.workId, "running");
  // 2026-08-19 P1:首次启动不再预支恢复次数(此前实际恢复余量是 4 次而非 5 次)
  await d.startWork(next.workId).catch((err) => {
    console.warn(`[work-queue] 首次启动 ${next.workId} 失败:`, err instanceof Error ? err.message : err);
  });
}

/** 检查作品 output/ 下是否已有成片(final 开头的视频文件,与 reconcile 判定一致;
 *  job_*_final.mp4 分段渲染产物不算 —— 2026-08-16 d34 误判事故) */
function hasFinalOutput(workId: string): boolean {
  try {
    const outDir = join(dataDir, "works", workId, "output");
    if (!existsSync(outDir)) return false;
    return readdirSync(outDir).some(
      (f) => /^final/i.test(f) && /\.(mp4|mov|webm)$/i.test(f),
    );
  } catch {
    return false;
  }
}

/** 流水线是否已全部 finish（done/skipped）——配合 hasFinalOutput 判断"真完成" */
function allStepsFinished(work: { pipeline: Record<string, { status: string }> }): boolean {
  const steps = Object.values(work.pipeline);
  return steps.length > 0 && steps.every((s) => s.status === "done" || s.status === "skipped");
}
