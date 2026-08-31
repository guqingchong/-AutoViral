/**
 * 服务端系统语音播报(2026-08-31,实测需求)。
 *
 * 场景:用户不会时刻盯着作品页,关键阻塞(H3 离线/eco 拦截/评审受阻/待审核)
 * 需要"听得见"的提醒。服务跑在用户本机,直接用 Windows SAPI 系统语音播报,
 * 即使浏览器没开也能听到。
 *
 * 纪律:
 * - 仅 Windows 生效,其他平台静默跳过;fire-and-forget,绝不阻塞业务链路
 * - 防抖聚合:同一文本 3 分钟内只播一次,窗口内重复的出现次数在窗口结束时
 *   汇总播一句"另有 N 条相同提醒"(watchdog 启动时 8 连发 fail_visible 的教训)
 * - 全局限速:每分钟最多播 4 条,防极端情况下语音轰炸
 * - 环境变量 AUTOVIRAL_VOICE_NOTIFY=0 可整体关闭
 */

import { spawn } from "node:child_process";

const SUPPRESS_MS = 3 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 4;

interface Pending { count: number; timer: NodeJS.Timeout }
const recent = new Map<string, Pending>();
const speakLog: number[] = [];

function enabled(): boolean {
  return process.platform === "win32"
    && process.env.AUTOVIRAL_VOICE_NOTIFY !== "0"
    && !process.env.VITEST; // 测试环境不真的发声
}

function speakNow(text: string): void {
  if (!enabled()) return;
  // base64 传文本,规避 PowerShell 字符串转义/中文编码问题
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  const ps = [
    "Add-Type -AssemblyName System.Speech;",
    "$t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'));",
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$s.Rate=1;",
    "$s.Speak($t);",
    "$s.Dispose();",
  ].join(" ");
  try {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // 播报失败不影响业务
  }
}

function rateLimited(): boolean {
  const now = Date.now();
  while (speakLog.length && now - speakLog[0] > RATE_WINDOW_MS) speakLog.shift();
  return speakLog.length >= RATE_MAX;
}

/**
 * 播报一条提醒。key 用于去重(默认取文本前 60 字)。
 * 同一 key 在抑制窗口内重复出现时,窗口结束补播一条汇总。
 */
export function voiceNotify(text: string, key?: string): void {
  if (!enabled()) return;
  const k = key ?? text.slice(0, 60);
  const existing = recent.get(k);
  if (existing) {
    existing.count++;
    return;
  }
  if (rateLimited()) return;
  speakLog.push(Date.now());
  speakNow(`AutoViral 提醒:${text}`);
  const timer = setTimeout(() => {
    const p = recent.get(k);
    recent.delete(k);
    if (p && p.count > 0 && !rateLimited()) {
      speakLog.push(Date.now());
      speakNow(`AutoViral 提醒:另有 ${p.count} 条与刚才相同的提醒,请到控制台查看`);
    }
  }, SUPPRESS_MS);
  recent.set(k, { count: 0, timer });
}

/** 测试用/日终清理:清掉抑制窗口 */
export function _resetVoiceNotify(): void {
  for (const p of recent.values()) clearTimeout(p.timer);
  recent.clear();
  speakLog.length = 0;
}
