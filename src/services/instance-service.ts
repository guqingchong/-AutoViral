import { checkHealth } from "./heygem-client.js";
import { getConfig } from "../config.js";

/**
 * 实例状态服务（手动控制模式）。
 * 实例开关机由用户在 AutoDL 控制台手动操作，本服务只做两件事：
 *   1. 健康探测驱动 ready/offline 状态（30 秒循环 + getInstanceView 实时探测）
 *   2. 空闲计时，供前端提醒用户及时关机避免持续计费
 */
export type InstanceViewState = "ready" | "offline";

export interface InstanceView {
  state: InstanceViewState;
  gpuHourlyRateYuan: number;
  idleReminderMinutes: number;
  lastActivityAt: string | null;
  /** 当前空闲分钟数；无任何活动时（lastActivityAt 为 null）为 0 */
  idleMinutes: number;
  /** AutoDL 控制台地址，前端引导用户去手动开关机 */
  consoleUrl: string;
}

const HEALTH_LOOP_INTERVAL_MS = 30_000;
const AUTODL_CONSOLE_URL = "https://www.autodl.com/console";

let state: InstanceViewState = "offline";
let lastActivity: number | null = null;
let healthLoop: NodeJS.Timeout | undefined;

export function recordActivity(): void {
  lastActivity = Date.now();
}

async function probe(): Promise<void> {
  try {
    state = (await checkHealth()) ? "ready" : "offline";
  } catch {
    // checkHealth 本身不抛异常，这里兜底防意外
    state = "offline";
  }
}

export async function getInstanceView(): Promise<InstanceView> {
  // 实时探测一次，保证状态新鲜（状态同时由 30 秒健康环在后台刷新）
  await probe();
  const heygem = getConfig().heygem;
  return {
    state,
    gpuHourlyRateYuan: heygem?.gpuHourlyRateYuan ?? 0,
    idleReminderMinutes: heygem?.idleReminderMinutes ?? 15,
    lastActivityAt: lastActivity !== null ? new Date(lastActivity).toISOString() : null,
    idleMinutes: lastActivity === null ? 0 : Math.floor((Date.now() - lastActivity) / 60_000),
    consoleUrl: AUTODL_CONSOLE_URL,
  };
}

export async function assertReady(): Promise<void> {
  if (state !== "ready") {
    throw new Error("实例离线，请先到 AutoDL 控制台开机");
  }
}

/** 服务启动时调用：立即探测一次 + 每 30 秒探测（unref 不阻塞进程退出） */
export function startHealthLoop(): void {
  if (healthLoop) return;
  void probe();
  healthLoop = setInterval(() => {
    void probe();
  }, HEALTH_LOOP_INTERVAL_MS);
  healthLoop.unref();
}

export function stopHealthLoop(): void {
  if (healthLoop) {
    clearInterval(healthLoop);
    healthLoop = undefined;
  }
}

/** 仅测试使用：重置模块级状态 */
export function __resetForTests(): void {
  stopHealthLoop();
  state = "offline";
  lastActivity = null;
}
