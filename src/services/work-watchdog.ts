// 反停滞看门狗 — 定期扫描处于中间状态的作品，找出"最近活动时间"超过阈值
// 且会话已死的作品：不在队列的（历史遗留）重新入队，随后唤醒串行 Runner 恢复执行。
// 会话仍存活的作品视为"只是慢"，不动。

import { getDb } from "../db/connection.js";
import * as queueRepo from "../db/work-queue-repo.js";
import { latestTimestamp, parseTsMs } from "../db/time.js";
import { kickRunner } from "./work-queue.js";
import { failVisible } from "./fail-visible.js";

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
/** 批次7.8:扩展维度的告警去重(每个对象每个维度只告警一次,防 60s 扫描刷屏) */
const alerted = new Set<string>();
const alertOnce = (key: string, scope: { workId?: string; stage?: string }, reason: string): void => {
  if (alerted.has(key)) return;
  alerted.add(key);
  failVisible(scope, reason);
};

/**
 * 批次7.8 扩展维度(v2-M6 X-1):reviewing 滞留/数字人渲染池/发布记录 此前全是监控盲区。
 * 只告警不自动处置(reviewing=等人工是正常态,但滞留 24h+ 值得提醒;
 * 数字人/发布的停滞另有轮询/cron 负责恢复,这里兜底可见性)。
 */
function scanExtendedDimensions(now: Date): void {
  const db = getDb();
  // reviewing 滞留 >24h(全库曾 8/12 作品永久停 reviewing)
  const reviewingRows = db
    .prepare("SELECT id, updated_at FROM works WHERE status = 'reviewing'")
    .all() as { id: string; updated_at: string }[];
  for (const r of reviewingRows) {
    const ms = parseTsMs(r.updated_at);
    if (ms !== null && now.getTime() - ms > 24 * 3600_000) {
      alertOnce(`reviewing:${r.id}`, { workId: r.id, stage: "reviewing" },
        `作品已停在"待审核"超过 24 小时,请前往审核或处置`);
    }
  }
  // 数字人渲染任务 running 滞留 >30min(DB 级兜底;轮询超时修复之外的漏网)
  const dhRows = db
    .prepare("SELECT id, work_id, updated_at FROM digital_human_jobs WHERE status = 'running'")
    .all() as { id: string; work_id: string; updated_at: string }[];
  for (const r of dhRows) {
    const ms = parseTsMs(r.updated_at);
    if (ms !== null && now.getTime() - ms > 30 * 60_000) {
      alertOnce(`dh:${r.id}`, { workId: r.work_id, stage: "digital-human" },
        `数字人渲染任务 ${r.id.slice(0, 12)} 滞留 running 超 30 分钟,疑似无人轮询`);
    }
  }
  // 发布记录 publishing 滞留 >15min(发布 cron 的恢复之外的兜底告警)
  const pubRows = db
    .prepare("SELECT id, work_id, platform, updated_at FROM publish_records WHERE status = 'publishing'")
    .all() as { id: number; work_id: string; platform: string; updated_at: string }[];
  for (const r of pubRows) {
    const ms = parseTsMs(r.updated_at);
    if (ms !== null && now.getTime() - ms > 15 * 60_000) {
      alertOnce(`pub:${r.id}`, { workId: r.work_id, stage: "publish" },
        `发布记录 #${r.id}(${r.platform})停在 publishing 超 15 分钟,疑似挂起`);
    }
  }
}

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
    scanExtendedDimensions(new Date());
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
