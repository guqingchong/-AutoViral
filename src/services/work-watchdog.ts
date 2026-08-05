// 反停滞看门狗 — 定期扫描处于中间状态的作品，找出"最近活动时间"超过阈值
// 且会话已死的作品：不在队列的（历史遗留）重新入队，随后唤醒串行 Runner 恢复执行。
// 会话仍存活的作品视为"只是慢"，不动。

import { getDb } from "../db/connection.js";
import * as queueRepo from "../db/work-queue-repo.js";
import { latestTimestamp, parseTsMs } from "../db/time.js";
import { kickRunner } from "./work-queue.js";

/** 停滞阈值：最近活动超过 10 分钟视为停滞 */
export const STALL_MS = 10 * 60 * 1000;
/** 看门狗扫描间隔 */
const SCAN_INTERVAL_MS = 60_000;
/** 流水线中间状态（终态 draft/reviewing/published/failed 不在监控范围） */
const INTERMEDIATE_STATUSES = ["researching", "planning", "assetting", "assembling"] as const;

export interface StalledWork {
  id: string;
  status: string;
  lastActivity: string | null;
}

export interface WatchdogDeps {
  // 看门狗只负责"入队 + 唤醒 runner"，不直接启动会话（启动是 runner 的职责），
  // 因此不需要 startWork 依赖。
  isSessionAlive: (workId: string) => boolean;
}

/**
 * 计算作品的最近活动时间：所有 pipeline_steps 的 started_at/completed_at
 * 与 works.updated_at 中的最大值（混合格式统一解析后比较，返回原始字符串）。
 */
export function lastActivityOf(
  updatedAt: string | null | undefined,
  stepTimes: Array<string | null | undefined>,
): string | null {
  return latestTimestamp([updatedAt, ...stepTimes]);
}

interface ActivityRow {
  id: string;
  status: string;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * 找出停滞作品：中间状态 + 最近活动距今超过 STALL_MS。
 * 纯查询函数（同步，better-sqlite3），可注入 now 便于测试。
 * 注意：started_at/completed_at（ISO 带 T/Z）与历史可能存在的
 * datetime('now') 空格格式混存，不能在 SQL 里直接做字符串 MAX 比较，
 * 统一在 JS 侧解析为毫秒后比较。
 */
export function findStalledWorks(now: Date = new Date()): StalledWork[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.id, w.status, w.updated_at, ps.started_at, ps.completed_at
       FROM works w
       LEFT JOIN pipeline_steps ps ON ps.work_id = w.id
       WHERE w.status IN (${INTERMEDIATE_STATUSES.map(() => "?").join(",")})`,
    )
    .all(...INTERMEDIATE_STATUSES) as ActivityRow[];

  const byWork = new Map<string, { status: string; times: Array<string | null> }>();
  for (const r of rows) {
    let entry = byWork.get(r.id);
    if (!entry) {
      entry = { status: r.status, times: [] };
      byWork.set(r.id, entry);
    }
    entry.times.push(r.updated_at, r.started_at, r.completed_at);
  }

  const stalled: StalledWork[] = [];
  for (const [id, entry] of byWork) {
    const last = latestTimestamp(entry.times);
    const ms = parseTsMs(last);
    if (ms !== null && now.getTime() - ms > STALL_MS) {
      stalled.push({ id, status: entry.status, lastActivity: last });
    }
  }
  return stalled;
}

let timer: ReturnType<typeof setInterval> | null = null;
let scanning = false;

async function scanOnce(deps: WatchdogDeps): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    for (const stalled of findStalledWorks()) {
      if (deps.isSessionAlive(stalled.id)) continue; // 会话活着只是慢，不动
      // 不在队列的停滞作品（历史遗留）→ 入队；在队列的由 Runner 健康检查负责恢复
      if (!queueRepo.getItem(stalled.id)) queueRepo.enqueue(stalled.id);
      kickRunner();
    }
  } finally {
    scanning = false;
  }
}

/** 启动看门狗定时扫描（重复调用幂等）。intervalMs 可注入便于测试。 */
export function startWatchdog(deps: WatchdogDeps, intervalMs: number = SCAN_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    void scanOnce(deps);
  }, intervalMs);
  // 不阻止进程退出
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 测试用：手动触发一次扫描（不经过 setInterval） */
export function _scanOnceForTest(deps: WatchdogDeps): Promise<void> {
  return scanOnce(deps);
}

/** 测试/关闭用：重置内部状态 */
export function _resetWatchdog(): void {
  stopWatchdog();
  scanning = false;
}
