import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { getConfig, HEYGEM_TUNNEL_DEFAULTS, type HeygemTunnelConfig } from "../config.js";

/**
 * HeyGem 实例 SSH 隧道管理。
 *
 * AutoDL 实例所在区域的公网代理仅对企业认证开放，个人用户只能通过 SSH 隧道
 * 访问实例服务。本模块负责隧道全生命周期：
 *   - ensureTunnel(): 隧道已在跑 → true；否则 spawn ssh 端口转发并等待本地
 *     端口可连接（最长 15 秒）。本机已有手动隧道占用端口且可用时直接复用。
 *   - stopTunnel(): 终止由本模块启动的隧道进程（不动外部手动隧道）。
 *   - isTunnelRunning(): 本模块启动的隧道进程是否存活。
 *
 * 隧道进程不 detached、不 unref，随 AutoViral 进程退出而终止，不留孤儿进程。
 * 前置条件：本机已配置对该实例的免密 SSH（BatchMode=yes 下不允许交互输密码）。
 */

const CONNECT_ATTEMPTS = 30;       // 每 500ms 试一次，共 15 秒
const CONNECT_INTERVAL_MS = 500;

let child: ChildProcess | undefined;

function resolveTunnelConfig(): HeygemTunnelConfig {
  const t = getConfig().heygem?.tunnel;
  return { ...HEYGEM_TUNNEL_DEFAULTS, ...(t ?? {}) };
}

/** 尝试连接本地端口，可连接（说明隧道或别的转发在生效）→ true */
function isPortConnectable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPort(port: number): Promise<boolean> {
  for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
    if (await isPortConnectable(port)) return true;
    await new Promise((r) => setTimeout(r, CONNECT_INTERVAL_MS));
  }
  return false;
}

export function isTunnelRunning(): boolean {
  return child !== undefined && child.exitCode === null && !child.killed;
}

export async function ensureTunnel(): Promise<boolean> {
  const cfg = resolveTunnelConfig();

  if (isTunnelRunning()) return true;

  // 本地端口已可连接（例如用户手动开的隧道）→ 直接复用，不重复 spawn
  if (await isPortConnectable(cfg.localPort)) return true;

  const args = [
    "-N",
    "-L", `${cfg.localPort}:127.0.0.1:${cfg.remotePort}`,
    "-p", String(cfg.port),
    `${cfg.user}@${cfg.host}`,
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ExitOnForwardFailure=yes",
  ];

  let proc: ChildProcess;
  try {
    proc = spawn("ssh", args, { stdio: "ignore", detached: false, windowsHide: true });
  } catch {
    return false;
  }
  child = proc;
  // 进程退出/启动失败时清空引用，允许下次 ensureTunnel 重建；
  // 用闭包比较避免旧进程的 exit 事件误清新进程的引用
  proc.on("exit", () => { if (child === proc) child = undefined; });
  proc.on("error", () => { if (child === proc) child = undefined; });

  const ok = await waitForPort(cfg.localPort);
  if (!ok) {
    stopTunnel();
    return false;
  }
  return true;
}

export function stopTunnel(): void {
  if (child) {
    try { child.kill(); } catch { /* 已退出 */ }
    child = undefined;
  }
}

/** 仅测试使用：重置模块级状态 */
export function __resetForTests(): void {
  stopTunnel();
}
