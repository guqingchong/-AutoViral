/**
 * 模板分幕故事板预览图(2026-08-13 模板库改造:克隆模板"无法预览全部"修复)。
 *
 * 背景:模板卡片 poster 只渲染前 5 秒——多幕长模板(克隆产出的可达数分钟)
 * 只能看到第一幕,且兜底线框图把所有图层无视时间轴叠在一起,信息失真。
 *
 * 做法:按场景检测(template-scenes)给每一幕渲染一张全尺寸分图
 * (scene-0.png … scene-N.png,前端灯箱逐张查看;克隆视频有几幕就出几张),
 * 再拼一张网格总览作卡片 poster。每张分图只画该幕时间窗内可见的图层:
 * shape/text 按版式绘制;video/image 层画占位框并标注变量名。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getFFmpegPath } from "../video/ffmpeg.js";
import {
  escapeDrawtext,
  escapeFilterPath,
  lineHeightFor,
  normalizeColorForFfmpeg,
  resolveFontPaths,
  wrapTextLines,
} from "../video/draw-utils.js";
import { detectScenes } from "./template-scenes.js";
import type { DbTemplate } from "../db/templates-repo.js";

const execFileAsync = promisify(execFile);

const CELL_WIDTH = 360;

interface LayerRec {
  id?: string;
  type?: string;
  shape?: string;
  fill?: string;
  color?: string;
  content?: string;
  text?: string;
  source?: string;
  start?: number;
  duration?: number;
  position?: { x?: number; y?: number } | string;
  size?: { width?: number; height?: number };
  fontSize?: number;
  align?: string;
}

function resolveTextContent(template: DbTemplate, raw: string): string {
  let text = raw;
  for (const v of template.variables ?? []) {
    // 占位变量显示为「标签」,让故事板能看出这里填什么
    const placeholder = v.default !== undefined ? String(v.default) : `【${v.label ?? v.name}】`;
    text = text.replace(new RegExp(`\\{\\{${v.name}\\}\\}`, "g"), placeholder);
  }
  return text.replace(/\{\{[^}]+\}\}/g, "");
}

/** 单个采样时刻的可见图层 → ffmpeg drawbox/drawtext 滤镜链 */
function buildMomentFilters(template: DbTemplate, t: number, fontPath: string): string[] {
  const parts: string[] = [];
  const variables = template.variables ?? [];
  const canvasW = template.canvas?.width ?? 1080;
  const canvasH = template.canvas?.height ?? 1920;
  // position 可能是 "center"/"top"/"bottom" 等方位词(克隆产出的字幕层实测如此)
  const resolvePos = (l: LayerRec): { x: number; y: number } => {
    const sw = l.size?.width ?? 100;
    const sh = l.size?.height ?? 100;
    if (typeof l.position === "object" && l.position) return { x: l.position.x ?? 0, y: l.position.y ?? 0 };
    switch (l.position) {
      case "center": return { x: Math.round((canvasW - sw) / 2), y: Math.round((canvasH - sh) / 2) };
      case "top": return { x: Math.round((canvasW - sw) / 2), y: 80 };
      case "bottom": return { x: Math.round((canvasW - sw) / 2), y: canvasH - sh - 80 };
      default: return { x: 0, y: 0 };
    }
  };
  for (const raw of template.layers ?? []) {
    const l = raw as LayerRec;
    const start = l.start ?? 0;
    const end = start + (l.duration ?? 0);
    if (t < start || t >= end) continue;
    const { x: px, y: py } = resolvePos(l);
    const sw = l.size?.width ?? 100;
    const sh = l.size?.height ?? 100;

    if (l.type === "shape") {
      const hasFill = (l.fill ?? l.color) && !/^(transparent|none)$/i.test((l.fill ?? l.color)!.trim());
      if (hasFill) {
        const fillHex = normalizeColorForFfmpeg(l.fill ?? l.color, template.canvas?.backgroundColor);
        parts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=${fillHex}:t=fill`);
      }
      const stroke = (l as { stroke?: { width?: number; color?: string } }).stroke;
      if (stroke?.width && stroke.width > 0) {
        const sc = normalizeColorForFfmpeg(stroke.color ?? "#FFFFFF");
        parts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=${sc}:t=${stroke.width}`);
      }
      if (!hasFill && !stroke?.width) {
        parts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=0xFFFFFF:t=fill`);
      }
    } else if (l.type === "text") {
      const text = resolveTextContent(template, l.content ?? l.text ?? "");
      if (!text.trim()) continue;
      const fontSize = l.fontSize ?? 40;
      const colorHex = normalizeColorForFfmpeg(l.color ?? "#FFFFFF");
      const lines = wrapTextLines(text, fontSize, l.size?.width);
      const lineH = lineHeightFor(fontSize);
      lines.forEach((line, i) => {
        parts.push(
          `drawtext=fontfile='${fontPath}':text='${escapeDrawtext(line)}':fontsize=${fontSize}:fontcolor=${colorHex}:x=${px}:y=${py + i * lineH}:borderw=1:bordercolor=0x000000@0.5`,
        );
      });
    } else if (l.type === "video" || l.type === "image") {
      // 占位框:暗底 + 变量标签,表明此处是外部素材槽位
      parts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=0x2a2a2a:t=fill`);
      parts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=0x666666:t=2`);
      const varName = (l.source ?? "").match(/\{\{([^}]+)\}\}/)?.[1];
      const label = variables.find((v) => v.name === varName)?.label ?? varName ?? (l.type === "video" ? "视频素材" : "图片素材");
      const icon = l.type === "video" ? "▶ " : "🖼 ";
      const fontSize = Math.max(18, Math.min(36, Math.round(sw / 12)));
      parts.push(
        `drawtext=fontfile='${fontPath}':text='${escapeDrawtext(icon + label)}':fontsize=${fontSize}:fontcolor=0xCCCCCC:x=${px}+(${sw}-text_w)/2:y=${py}+(${sh}-text_h)/2`,
      );
    }
  }
  return parts;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}分${s.toString().padStart(2, "0")}秒` : `${s}秒`;
}

export interface StoryboardResult {
  /** 分幕单帧数量(scene-0.png … scene-(N-1).png 已写入 outDir) */
  frameCount: number;
}

/**
 * 渲染模板分幕故事板:每幕一张全尺寸分图存为 outDir/scene-N.png,
 * 并拼一张网格总览存为 outDir/poster.png(卡片缩略用)。
 */
export async function renderStoryboardPoster(template: DbTemplate, outDir: string): Promise<StoryboardResult> {
  const width = template.canvas?.width ?? 1080;
  const height = template.canvas?.height ?? 1920;
  const bgColor = normalizeColorForFfmpeg(template.canvas?.backgroundColor ?? "#0a0a0a");
  const fontPath = escapeFilterPath((await resolveFontPaths()).bold);
  const ffmpeg = await getFFmpegPath();

  const layers = (template.layers ?? []) as LayerRec[];
  // 场景数 = 分图数:克隆视频有几幕就几张(2026-08-13 用户决策,不再固定 6 张)
  const scenes = detectScenes(layers, template.canvas ?? {});
  const samples = scenes.map((s, i) => ({ t: Math.min(s.end - 0.05, (s.start + s.end) / 2), scene: i }));

  await mkdir(outDir, { recursive: true });
  const posterPath = join(outDir, "poster.png");
  const workDir = join(tmpdir(), `storyboard-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const framePaths: string[] = [];
  try {
    // 逐幕渲染全尺寸分图
    for (const { t, scene } of samples) {
      const filters = buildMomentFilters(template, t, fontPath);
      // 左上角幕标(半透明底+白字):第 N 幕 · 时刻
      const tag = `第${scene + 1}幕 ${fmtTime(t)}`;
      filters.push(`drawbox=x=12:y=12:w=${110 + tag.length * 22}:h=52:color=0x000000@0.55:t=fill`);
      filters.push(`drawtext=fontfile='${fontPath}':text='${escapeDrawtext(tag)}':fontsize=30:fontcolor=white:x=26:y=22`);
      const framePath = join(workDir, `f${scene}.png`);
      await execFileAsync(ffmpeg, [
        "-f", "lavfi", "-i", `color=c=${bgColor}:s=${width}x${height}:d=1`,
        "-vf", filters.length > 0 ? filters.join(",") : "null",
        "-frames:v", "1", "-y", framePath,
      ], { timeout: 15000 });
      framePaths.push(framePath);
      // 全尺寸分图落盘,供前端灯箱逐张查看
      const scenePath = join(outDir, `scene-${scene}.png`);
      await execFileAsync(ffmpeg, ["-i", framePath, "-y", scenePath], { timeout: 10000 });
    }

    // 拼网格总览(卡片 poster):列数随幕数自适应;单幕无需 xstack 直接缩放
    const cols = framePaths.length <= 1 ? 1 : framePaths.length <= 4 ? 2 : 3;
    const cellH = Math.round((CELL_WIDTH * height) / width / 2) * 2;
    if (framePaths.length === 1) {
      await execFileAsync(ffmpeg, [
        "-i", framePaths[0],
        "-vf", `scale=${CELL_WIDTH}:${cellH}:force_original_aspect_ratio=decrease,pad=${CELL_WIDTH}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x111111`,
        "-frames:v", "1", "-y", posterPath,
      ], { timeout: 15000 });
      return { frameCount: 1 };
    }
    const inputs = framePaths.flatMap((p) => ["-i", p]);
    const scaleParts = framePaths.map(
      (_, i) => `[${i}:v]scale=${CELL_WIDTH}:${cellH}:force_original_aspect_ratio=decrease,pad=${CELL_WIDTH}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x111111[c${i}]`,
    );
    const layout = framePaths
      .map((_, i) => `${(i % cols) * CELL_WIDTH}_${Math.floor(i / cols) * cellH}`)
      .join("|");
    const labels = framePaths.map((_, i) => `[c${i}]`).join("");
    await execFileAsync(ffmpeg, [
      ...inputs,
      "-filter_complex", `${scaleParts.join(";")};${labels}xstack=inputs=${framePaths.length}:layout=${layout}[out]`,
      "-map", "[out]", "-frames:v", "1", "-y", posterPath,
    ], { timeout: 15000 });

    return { frameCount: framePaths.length };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* 清理失败无碍 */ });
  }
}
