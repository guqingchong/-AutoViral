import { getConfig } from "../config.js";
import { ensureH3Tunnel, resolveH3TunnelConfig, rotateH3Tunnel, stopH3Tunnel } from "./h3-tunnel-service.js";

/**
 * MiniMax H3 本地视频生成实例（AutoDL ComfyUI）状态服务（手动控制模式）。
 *
 * 与 heygem 数字人实例共用同一 AutoDL 实例：实例开关机由用户在 AutoDL
 * 控制台手动操作，本服务只做两件事：
 *   1. 健康探测驱动 ready/offline 状态（30 秒循环 + getH3InstanceView 实时探测），
 *      探测失败时自动重建 SSH 隧道并重试一次（隧道掉线自愈）
 *   2. 空闲计时，供前端提醒用户及时关机避免持续计费
 *
 * eco 档素材策略依赖本服务：H3 离线时素材任务阻塞并显著提醒用户开机，
 * 实例上线（健康探测跳变）后由等待方自动继续。
 */

export type H3InstanceState = "ready" | "offline";

export interface H3InstanceView {
  state: H3InstanceState;
  gpuHourlyRateYuan: number;
  idleReminderMinutes: number;
  lastActivityAt: string | null;
  /** 当前空闲分钟数；无任何活动时（lastActivityAt 为 null）为 0 */
  idleMinutes: number;
  /** AutoDL 控制台地址，前端引导用户去手动开关机 */
  consoleUrl: string;
}

const HEALTH_LOOP_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const AUTODL_CONSOLE_URL = "https://www.autodl.com/console";

let state: H3InstanceState = "offline";
let lastActivity: number | null = null;
let healthLoop: NodeJS.Timeout | undefined;

export function recordH3Activity(): void {
  lastActivity = Date.now();
}

function resolveH3BaseUrl(): string {
  const cfg = getConfig().h3;
  if (cfg?.baseUrl) return cfg.baseUrl.replace(/\/$/, "");
  return `http://localhost:${resolveH3TunnelConfig().localPort}`;
}

/** ComfyUI 健康探测：GET /system_stats，通 → true。永不抛异常 */
export async function checkH3Health(): Promise<boolean> {
  if (!getConfig().h3) return false;
  try {
    const res = await fetch(`${resolveH3BaseUrl()}/system_stats`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probe(): Promise<void> {
  try {
    if (await checkH3Health()) {
      state = "ready";
      return;
    }
    // 探测失败：可能是 SSH 隧道掉线。配置了 h3 时尝试重建隧道并重试一次。
    if (getConfig().h3 && (await ensureH3Tunnel()) && (await checkH3Health())) {
      state = "ready";
      return;
    }
    // 隧道通但服务不响应(假通:目标实例上 ComfyUI 没启动)→ 切下一个候选实例
    if (getConfig().h3 && (await rotateH3Tunnel()) && (await checkH3Health())) {
      state = "ready";
      return;
    }
    state = "offline";
  } catch {
    state = "offline";
  }
}

export async function getH3InstanceView(): Promise<H3InstanceView> {
  // 实时探测一次，保证状态新鲜（状态同时由 30 秒健康环在后台刷新）
  await probe();
  const h3 = getConfig().h3;
  return {
    state,
    gpuHourlyRateYuan: h3?.gpuHourlyRateYuan ?? 2.18,
    idleReminderMinutes: h3?.idleReminderMinutes ?? 30,
    lastActivityAt: lastActivity !== null ? new Date(lastActivity).toISOString() : null,
    idleMinutes: lastActivity === null ? 0 : Math.floor((Date.now() - lastActivity) / 60_000),
    consoleUrl: AUTODL_CONSOLE_URL,
  };
}

/**
 * eco 档阻塞等待：H3 离线时挂起，直到实例上线（健康探测 ready）。
 * 调用方（素材生成）在等待期间应已向用户发出"请开机 AutoDL 实例"的显著提醒。
 * timeoutMs 默认 30 分钟（实例开机 + ComfyUI 启动约 10 分钟，留足余量）。
 */
export async function waitH3Ready(timeoutMs = 30 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await probe();
    if (state === "ready") return;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("等待 H3 实例上线超时（30 分钟）：请检查 AutoDL 实例是否已开机、ComfyUI 是否已启动");
}

export async function assertH3Ready(): Promise<void> {
  await probe();
  if (state !== "ready") {
    throw new Error("H3 实例离线：请到 AutoDL 控制台开机并启动 ComfyUI（eco 档禁用云端视频生成，不使用 H3 无法继续）");
  }
}

// ── H3 用量跟踪(2026-08-31 实测需求):AutoDL 按时计费,用户需要两个精确时点提醒——
// ①真正开始生成时提醒开机(在 /api/generate/video 503 处,不在开工时);
// ②素材阶段 AI 视频全部生成完时提醒关机。此处按作品记录"是否用过 H3"。
const h3UsedWorks = new Set<string>();

export function markH3UsedForWork(workId: string): void {
  h3UsedWorks.add(workId);
}

export function h3WasUsedForWork(workId: string): boolean {
  return h3UsedWorks.has(workId);
}

/** 服务启动时调用：立即探测一次 + 每 30 秒探测（unref 不阻塞进程退出） */
export function startH3HealthLoop(): void {
  if (healthLoop || !getConfig().h3) return;
  void probe();
  healthLoop = setInterval(() => {
    void probe();
  }, HEALTH_LOOP_INTERVAL_MS);
  healthLoop.unref();
}

export function stopH3HealthLoop(): void {
  if (healthLoop) {
    clearInterval(healthLoop);
    healthLoop = undefined;
  }
}

/** 仅测试使用：重置模块级状态 */
export function __resetForTests(): void {
  stopH3HealthLoop();
  stopH3Tunnel();
  state = "offline";
  lastActivity = null;
}
