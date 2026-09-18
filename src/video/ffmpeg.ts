import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { execFileSilent as execFileAsync } from "../utils/proc.js";

let ffmpegPathCache: string | null = null;

export async function getFFmpegPath(): Promise<string> {
  if (ffmpegPathCache) return ffmpegPathCache;
  const candidates = ["ffmpeg", "ffmpeg.exe"];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ["-version"]);
      ffmpegPathCache = bin;
      return bin;
    } catch { /* continue */ }
  }
  throw new Error("FFmpeg not found. Please install FFmpeg and ensure it is in PATH.");
}

export function resetFFmpegPathCache(): void {
  ffmpegPathCache = null;
}

export interface FFprobeInfo {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** Q1 补齐：采样率(Hz)与声道数——96kHz 事故的机器拦截依据 */
  sampleRate?: number;
  channels?: number;
}

/**
 * 静音轨归一化(2026-09-18 实测根因修复):程序化渲染(code-scene)与部分
 * stock 素材天然无音频流,"视频无音频轨"是素材评审 Critical 常客
 * (w_20260918_1519_b44 因此连挂两轮)。收尾/入库统一调本函数:
 * 无音轨则 mux 48kHz 立体声静音 AAC(长度对齐视频,-shortest),有音轨原样跳过。
 * 返回是否实际补轨。webm 容器用 libopus(AAC 不合法)。
 */
export async function ensureAudioTrack(path: string): Promise<boolean> {
  const info = await probeMedia(path);
  if (info.hasAudio) return false;
  const ffmpeg = await getFFmpegPath();
  const isWebm = /\.webm$/i.test(path);
  const tmp = path.replace(/(\.[^.]+)$/, ".audnorm$1");
  await execFileAsync(ffmpeg, [
    "-i", path,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", ...(isWebm ? ["-c:a", "libopus"] : ["-c:a", "aac", "-b:a", "128k"]),
    "-shortest", "-y", tmp,
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
  return true;
}

export async function probeMedia(path: string): Promise<FFprobeInfo> {
  const ffprobe = existsSync("ffprobe.exe") ? "ffprobe.exe" : "ffprobe";
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration",
      "-show_entries", "format=duration",
      "-of", "json",
      path,
    ]);
    const data = JSON.parse(stdout);
    const stream = data.streams?.[0] ?? {};
    const format = data.format ?? {};
    let duration: number | undefined;
    if (format.duration) duration = Number(format.duration);
    else if (stream.duration) duration = Number(stream.duration);

    const audio = await execFileAsync(ffprobe, [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type,sample_rate,channels",
      "-of", "csv=p=0",
      path,
    ]).then(r => r.stdout.trim()).catch(() => "");

    let sampleRate: number | undefined;
    let channels: number | undefined;
    if (audio.includes("audio")) {
      // CSV 形如 "audio,44100,2"（sample_rate/channels 取首个音频流的后续列）
      const parts = audio.split("\n")[0]?.split(",") ?? [];
      sampleRate = Number(parts[1]) || undefined;
      channels = Number(parts[2]) || undefined;
    }

    return {
      duration,
      width: stream.width ? Number(stream.width) : undefined,
      height: stream.height ? Number(stream.height) : undefined,
      hasAudio: audio.includes("audio"),
      sampleRate,
      channels,
    };
  } catch {
    return {};
  }
}
