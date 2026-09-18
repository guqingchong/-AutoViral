/**
 * 静图转视频段服务(2026-09-11,快照卡镜头抖动复盘)。
 *
 * 来源:w_20260910_1758_479 快照卡镜头由 agent 手搓 mk_segments.py:
 * scale=1920(仅 1×)后裸 zoompan 推镜 6%——违反防抖红线(必须 ≥3× 超采样 +
 * 总变倍 ≤5%),亚像素步进导致肉眼可见抖动。红线写了但无任何机器/服务兜底。
 *
 * 本服务收口静图→视频段:
 *   motion:"none"(默认)——纯静态 + 0.3s 淡入淡出,零抖动风险;
 *   motion:"push"       ——缓推镜,先 3× 超采样再 zoompan(总变倍 ≤4%),
 *                          即防抖红线方案②的服务化实现。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDir } from "../config.js";
import { resolveSafe } from "./vision-check.js";

import { execFileSilent as execFileAsync } from "../utils/proc.js";

export interface StillClipInput {
  workId?: string;
  /** 图片路径(相对作品目录或 dataDir 内绝对路径) */
  image: string;
  /** 段时长(秒) */
  duration: number;
  /** 输出 mp4(相对作品目录,如 assets/clips/shot-26.mp4) */
  out: string;
  /** 画幅,默认 1920×1080 */
  size?: { w: number; h: number };
  /** none(默认,纯静态+淡入淡出)| push(3× 超采样缓推 ≤4%) */
  motion?: "none" | "push";
  /** 补边底色(图片宽高比与画幅不一致时),默认深底 #111827 */
  bg?: string;
  fps?: number;
}

export interface StillClipResult {
  path: string;
  duration: number;
  motion: string;
}

export async function renderStillClip(input: StillClipInput): Promise<StillClipResult> {
  if (!input.image) throw new Error("image 必填");
  if (!(input.duration > 0)) throw new Error("duration 必须 > 0");
  if (!input.out) throw new Error("out 必填(相对作品目录的 mp4 路径)");
  const imgPath = resolveSafe(input.image, input.workId);
  if (!existsSync(imgPath)) throw new Error(`图片不存在:${imgPath}`);
  const workDir = input.workId ? resolve(join(dataDir, "works", input.workId)) : resolve(dataDir);
  const outPath = resolve(workDir, input.out);
  const root = resolve(dataDir);
  if (outPath !== root && !outPath.startsWith(root + sep)) throw new Error(`out 路径越界:${input.out}`);
  await mkdir(dirname(outPath), { recursive: true });

  const W = input.size?.w ?? 1920;
  const H = input.size?.h ?? 1080;
  const fps = input.fps ?? 30;
  const dur = input.duration;
  const bg = input.bg ?? "0x111827";
  const motion = input.motion ?? "none";

  // 静图入、统一画幅:等比缩放(decrease,横竖版都不越界)+ 深底补边
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg}`;
  const fade = `fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, dur - 0.3).toFixed(2)}:d=0.3`;
  let vf: string;
  if (motion === "push") {
    // 防抖红线方案②:3× 超采样(并补边到目标画幅,防非 16:9 源被 zoompan 拉伸)
    // 再 zoompan(亚像素步进 ÷3,肉眼不可见),总变倍 ≤4%
    const frames = Math.round(dur * fps);
    const step = Math.min(0.04 / frames, 0.0004); // 全程 ≤4%
    vf = `scale=${W * 3}:${H * 3}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W * 3}:${H * 3}:(ow-iw)/2:(oh-ih)/2:color=${bg},` +
      `zoompan=z='min(1+${step.toFixed(6)}*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},` +
      fade + `,format=yuv420p`;
  } else {
    vf = `${fit},fps=${fps},${fade},format=yuv420p`;
  }

  const args = ["-y", "-v", "error", "-loop", "1", "-framerate", String(fps), "-i", imgPath,
    "-vf", vf, "-t", String(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", outPath];
  try {
    await execFileAsync("ffmpeg", args, { timeout: 120_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`静图转视频失败:${msg.slice(-300)}`);
  }
  return { path: outPath, duration: dur, motion };
}
