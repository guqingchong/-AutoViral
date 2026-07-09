export interface RenderProgress {
  frame?: number;
  fps?: number;
  time?: number; // seconds
  speed?: string;
  bitrate?: string;
  percent?: number;
}

export function parseFFmpegProgress(line: string, duration?: number): RenderProgress | undefined {
  const frame = extractNumber(line, "frame=");
  const fps = extractNumber(line, "fps=");
  const bitrate = extractString(line, "bitrate=");
  const speed = extractString(line, "speed=");
  const timeStr = extractString(line, "time=");
  let time: number | undefined;
  if (timeStr) {
    time = timeToSeconds(timeStr);
  }
  let percent: number | undefined;
  if (duration && duration > 0 && time !== undefined) {
    percent = Math.min(100, Math.max(0, (time / duration) * 100));
  }
  if (frame === undefined && time === undefined) return undefined;
  return { frame, fps, time, speed, bitrate, percent };
}

function extractNumber(line: string, prefix: string): number | undefined {
  const idx = line.indexOf(prefix);
  if (idx < 0) return undefined;
  const raw = line.slice(idx + prefix.length).trim().split(/\s/)[0];
  const num = Number(raw);
  return Number.isNaN(num) ? undefined : num;
}

function extractString(line: string, prefix: string): string | undefined {
  const idx = line.indexOf(prefix);
  if (idx < 0) return undefined;
  const rest = line.slice(idx + prefix.length).trim();
  const match = rest.match(/^([^\s]+)/);
  return match ? match[1] : undefined;
}

function timeToSeconds(time: string): number | undefined {
  const parts = time.split(":");
  if (parts.length !== 3) return undefined;
  const [hh, mm, ss] = parts;
  const sec = Number(ss);
  if (Number.isNaN(sec)) return undefined;
  return Number(hh) * 3600 + Number(mm) * 60 + sec;
}
