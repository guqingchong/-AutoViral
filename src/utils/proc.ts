/**
 * Windows 静默子进程工具(2026-09-11,终端弹窗治理)。
 *
 * 根因:服务器由 Electron(GUI 进程,无控制台)拉起,console 子系统的子进程
 * (node worker/ffmpeg/yt-dlp/rg/powershell…)缺省各自弹出新的控制台黑窗,
 * 素材/合成阶段高频调用时严重干扰用户工作。统一强制 windowsHide。
 *
 * 用法:各模块把 `const execFileAsync = promisify(execFile)` 换成
 * `import { execFileSilent as execFileAsync } from "../utils/proc.js"`;
 * spawn 调用在 options 里展开 `...SPAWN_HIDE`。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile) as (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

/** execFile(promisify 版) + 强制 windowsHide;调用方原有 options(timeout/maxBuffer 等)保留 */
export function execFileSilent(file: string, args?: string[] | Record<string, unknown>, options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  const a = Array.isArray(args) ? args : [];
  const o = (Array.isArray(args) ? options : args) ?? {};
  return execFileP(file, a, { ...o, windowsHide: true });
}

/** spawn 选项:强制隐藏 Windows 控制台窗口(展开进 spawn 的 options 即可) */
export const SPAWN_HIDE = { windowsHide: true } as const;
