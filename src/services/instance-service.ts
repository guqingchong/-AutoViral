import { powerOnInstance, powerOffInstance } from "./autodl-client.js";
import { checkHealth } from "./heygem-client.js";
import { countActiveJobs } from "../db/digital-human-jobs-repo.js";
import { getConfig } from "../config.js";

export type InstanceViewState = "stopped" | "starting" | "ready" | "stopping" | "failed" | "unknown";

export interface InstanceView {
  state: InstanceViewState;
  gpuHourlyRateYuan: number;
  idleShutdownMinutes: number;
  lastActivityAt: string | null;
  error: string | null;
}

const HEALTH_POLL_INTERVAL_MS = 10_000;
const HEALTH_POLL_MAX_ATTEMPTS = 30; // 30 * 10s = 5 分钟
const WATCHDOG_INTERVAL_MS = 60_000;

let state: InstanceViewState = "stopped";
let lastActivity: number | null = null;
let lastError: string | null = null;
let watchdog: NodeJS.Timeout | undefined;

export function recordActivity(): void {
  lastActivity = Date.now();
}

export async function getInstanceView(): Promise<InstanceView> {
  const autodl = getConfig().autodl;
  return {
    state,
    gpuHourlyRateYuan: autodl?.gpuHourlyRateYuan ?? 0,
    idleShutdownMinutes: autodl?.idleShutdownMinutes ?? 0,
    lastActivityAt: lastActivity !== null ? new Date(lastActivity).toISOString() : null,
    error: lastError,
  };
}

export async function powerOn(): Promise<InstanceView> {
  if (state === "ready" || state === "starting") {
    return getInstanceView();
  }
  state = "starting";
  lastError = null;
  try {
    await powerOnInstance();
    for (let attempt = 0; attempt < HEALTH_POLL_MAX_ATTEMPTS; attempt++) {
      if (await checkHealth()) {
        state = "ready";
        recordActivity();
        return getInstanceView();
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
    }
    state = "failed";
    lastError = "开机后健康检查未通过（5分钟）";
  } catch (err) {
    state = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }
  return getInstanceView();
}

export async function powerOff(): Promise<InstanceView> {
  const active = countActiveJobs();
  if (active > 0) {
    throw new Error(`有 ${active} 个任务在进行中，无法关机`);
  }
  state = "stopping";
  try {
    await powerOffInstance();
  } catch (err) {
    // 关机请求失败：实例大概率仍在运行，回退状态并记录错误，避免卡在 stopping 导致看门狗失效
    state = "ready";
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  }
  state = "stopped";
  lastError = null;
  return getInstanceView();
}

export async function assertReady(): Promise<void> {
  if (state !== "ready") {
    throw new Error("实例未就绪，请先在页面开机");
  }
}

export function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const idleMinutes = getConfig().autodl?.idleShutdownMinutes ?? 15;
    if (
      state === "ready" &&
      countActiveJobs() === 0 &&
      lastActivity !== null &&
      Date.now() - lastActivity > idleMinutes * 60_000
    ) {
      powerOff().catch((err) => {
        console.error("[instance-service] 看门狗自动关机失败:", err);
      });
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();
}

export function stopWatchdog(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = undefined;
  }
}

/** 仅测试使用：重置模块级状态 */
export function __resetForTests(): void {
  stopWatchdog();
  state = "stopped";
  lastActivity = null;
  lastError = null;
}
