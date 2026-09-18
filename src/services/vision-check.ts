/**
 * 视觉核验服务 API(2026-09-11,assets 105 分钟复盘改进点 3)。
 *
 * 来源:w_20260910_1758_479 assets 阶段,agent 手搓 vision-check.mjs + sleep
 * 轮询空等约 20 分钟——视觉模型配置在服务端,agent 侧拿不到也不该拿 API Key。
 * 现状缺口:D3 vision(assertImageTextVision)只覆盖图文卡,视频抽帧/快照卡的
 * 语义核验空白,agent 只能自写脚本。
 *
 * 本服务把"图片/视频抽帧 → 视觉模型 JSON 核验"收成一次同步 HTTP 调用:
 *   POST /api/assets/vision-check
 *   { workId, images:["assets/frames/s26a.jpg",...], prompt:"...", timeoutMs? }
 *   或 { workId, video:{ path:"assets/clips/shot-26.mp4", times:[0.5,2,4] }, prompt:"..." }
 * 返回 { result: <视觉模型输出的 JSON>, images: [...实际核验的图片] }。
 *
 * 路径安全:所有路径解析后必须落在 dataDir 内(作品目录/共享素材),防越界读盘。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname, sep } from "node:path";
import { dataDir } from "../config.js";
import type { Config } from "../config.js";

import { execFileSilent as execFileAsync } from "../utils/proc.js";

export interface VisionCheckInput {
  workId?: string;
  /** 图片路径列表(相对作品目录或 dataDir 内绝对路径),与 video 二选一 */
  images?: string[];
  /** 视频抽帧:服务端 ffmpeg 抽指定时间点(秒,缺省首/中/尾)后核验 */
  video?: { path: string; times?: number[] };
  /** 核验指令(要求模型输出 JSON,如 {"problems":[...],"pass":true}) */
  prompt: string;
  timeoutMs?: number;
}

export interface VisionCheckResult {
  result: unknown;
  images: string[];
}

/** 路径解析 + dataDir 边界校验(相对路径基于作品目录);still-clip 等服务同款复用 */
export function resolveSafe(p: string, workId?: string): string {
  const base = workId ? join(dataDir, "works", workId) : dataDir;
  const abs = resolve(base, p);
  const root = resolve(dataDir);
  // 边界须带分隔符:裸 startsWith 会让 "av_data2/..." 骗过 "av_data" 前缀
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径越界:${p}——视觉核验仅允许 dataDir 内的文件(作品目录/共享素材)`);
  }
  return abs;
}

/** 视频抽帧到临时目录,返回帧路径(默认首/10%/中/90%/尾前 5 点) */
async function extractFrames(videoPath: string, times?: number[]): Promise<{ frames: string[]; cleanup: () => Promise<void> }> {
  if (!existsSync(videoPath)) throw new Error(`视频不存在:${videoPath}`);
  let ts = times ?? [];
  if (ts.length === 0) {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", videoPath]);
    const dur = Number(JSON.parse(stdout).format?.duration ?? 0);
    if (!dur) throw new Error(`无法读取视频时长:${videoPath}`);
    ts = [0.5, dur * 0.1, dur * 0.5, dur * 0.9, Math.max(0.5, dur - 0.5)];
  }
  const tmp = await mkdtemp(join(tmpdir(), "av-vcheck-"));
  const frames: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const out = join(tmp, `f${i}.jpg`);
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-ss", String(ts[i]), "-i", videoPath, "-frames:v", "1", "-q:v", "3", out]);
    frames.push(out);
  }
  return { frames, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

export async function runVisionCheck(input: VisionCheckInput, config: Config): Promise<VisionCheckResult> {
  if (!input.prompt?.trim()) throw new Error("prompt 必填——说明核验什么、要求输出什么 JSON");
  let images: string[] = [];
  let cleanup: (() => Promise<void>) | null = null;
  if (input.video?.path) {
    const v = await extractFrames(resolveSafe(input.video.path, input.workId), input.video.times);
    images = v.frames;
    cleanup = v.cleanup;
  } else {
    images = (input.images ?? []).map((p) => resolveSafe(p, input.workId));
  }
  if (images.length === 0) throw new Error("images 或 video 必须提供一个");
  if (images.length > 8) throw new Error(`单次最多核验 8 张图(收到 ${images.length})——分批提交`);
  for (const p of images) {
    if (!existsSync(p)) throw new Error(`图片不存在:${p}`);
    if (!/\.(png|jpe?g|webp|gif)$/i.test(extname(p))) throw new Error(`不支持的图片格式:${p}`);
  }
  try {
    const { chatVisionJson } = await import("../llm/vision-json.js");
    const result = await chatVisionJson<unknown>(config, images, input.prompt, { timeoutMs: input.timeoutMs ?? 120_000 });
    return { result, images };
  } finally {
    if (cleanup) await cleanup();
  }
}
