import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

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
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      path,
    ]).then(r => r.stdout.trim()).catch(() => "");

    return {
      duration,
      width: stream.width ? Number(stream.width) : undefined,
      height: stream.height ? Number(stream.height) : undefined,
      hasAudio: audio.includes("audio"),
    };
  } catch {
    return {};
  }
}
