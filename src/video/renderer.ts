import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getFFmpegPath } from "./ffmpeg.js";
import { parseFFmpegProgress } from "./progress.js";
import { validateTimeline } from "./schema.js";
import type { Timeline, TimelineLayer, TimelinePosition, TimelineAnimation } from "./types.js";

export interface RenderOptions {
  outputPath: string;
  duration?: number;
  preview?: boolean;
  previewDuration?: number;
  onProgress?: (progress: { percent?: number; time?: number; speed?: string }) => void;
  abortSignal?: AbortSignal;
}

export interface RenderResult {
  outputPath: string;
  duration: number;
}

interface InputSlot {
  path: string;
  type: "video" | "image" | "audio";
  index: number;
  loop?: boolean;
}

export async function renderTimeline(timeline: Timeline, options: RenderOptions): Promise<RenderResult> {
  const tl = validateTimeline(timeline);
  const ffmpeg = await getFFmpegPath();
  const outputDuration = options.duration ?? computeDuration(tl);
  const renderDuration = options.preview ? Math.min(options.previewDuration ?? 5, outputDuration) : outputDuration;

  const inputs = collectInputs(tl);
  const args = buildFilterComplexArgs(tl, inputs, renderDuration, options.outputPath);

  // If the filter_complex string is very long, write it to a temporary script file to avoid
  // exceeding command-line argument length limits on Windows.
  const MAX_ARG_LENGTH = 8000;
  const filterIndex = args.indexOf("-filter_complex");
  let filterScriptPath: string | undefined;
  if (filterIndex >= 0 && args[filterIndex + 1].length > MAX_ARG_LENGTH) {
    filterScriptPath = join(tmpdir(), `av-filter-${randomUUID()}.txt`);
    await writeFile(filterScriptPath, args[filterIndex + 1], "utf-8");
    args[filterIndex] = "-filter_complex_script";
    args[filterIndex + 1] = filterScriptPath;
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;

    const abortHandler = () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
      }
    };
    options.abortSignal?.addEventListener("abort", abortHandler);

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        const p = parseFFmpegProgress(line, renderDuration);
        if (p && options.onProgress) {
          options.onProgress({ percent: p.percent, time: p.time, speed: p.speed });
        }
      }
    });

    proc.on("exit", (code) => {
      options.abortSignal?.removeEventListener("abort", abortHandler);
      if (filterScriptPath) {
        unlink(filterScriptPath).catch(() => {});
      }
      if (code === 0) {
        resolve({ outputPath: options.outputPath, duration: renderDuration });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", (err) => {
      options.abortSignal?.removeEventListener("abort", abortHandler);
      if (filterScriptPath) {
        unlink(filterScriptPath).catch(() => {});
      }
      reject(err);
    });
  });
}

export function computeDuration(tl: Timeline): number {
  const layerEnd = tl.layers.reduce((max, l) => Math.max(max, l.start + l.duration), 0);
  const audioEnd = tl.audio.reduce((max, a) => Math.max(max, (a.start ?? 0) + (a.duration ?? 0)), 0);
  return Math.max(layerEnd, audioEnd, 1);
}

export function collectInputs(tl: Timeline): InputSlot[] {
  const inputs: InputSlot[] = [];
  let index = 0;
  for (const layer of tl.layers) {
    if (layer.type === "video" || layer.type === "image") {
      inputs.push({ path: layer.source, type: layer.type, index: index++ });
    }
  }
  for (const audio of tl.audio) {
    inputs.push({ path: audio.source, type: "audio", index: index++, loop: audio.loop });
  }
  return inputs;
}

export function buildFilterComplexArgs(tl: Timeline, inputs: InputSlot[], duration: number, outputPath: string): string[] {
  const args: string[] = [];

  // Input declarations
  for (const input of inputs) {
    if (input.type === "image") {
      args.push("-loop", "1", "-i", input.path);
    } else {
      args.push("-i", input.path);
    }
  }

  const videoFilterParts: string[] = [];
  const audioFilterParts: string[] = [];

  // Categorize layers
  const mediaLayers = tl.layers.filter(l => l.type === "video" || l.type === "image");
  const visualLayers = tl.layers.filter(l => l.type === "video" || l.type === "image" || l.type === "text" || l.type === "shape");
  const hasVisual = visualLayers.length > 0;

  // Determine if we need an additional lavfi color background
  const firstIsMedia = hasVisual && (visualLayers[0].type === "video" || visualLayers[0].type === "image");
  const needsCanvasBg = !hasVisual || !firstIsMedia;
  let canvasBgIdx = -1;

  if (needsCanvasBg) {
    canvasBgIdx = inputs.length;
    args.push("-f", "lavfi", "-i", `color=c=${tl.canvas.backgroundColor ?? "black"}:s=${tl.canvas.width}x${tl.canvas.height}:r=${tl.canvas.fps}:d=${duration}`);
  }

  // ── Determine whether to use xfade transitions ──────────────────────────
  const hasTransitions = tl.transitions && tl.transitions.length > 0;

  // Sequential media layers that can be xfade-chained:
  // layers must be non-overlapping and ordered by start time.
  const xfadeMediaLayers = hasTransitions && mediaLayers.length >= 2
    ? mediaLayers.slice().sort((a, b) => a.start - b.start)
    : [];
  const useXfade = xfadeMediaLayers.length >= 2;
  let xfadeBaseLabel = "";

  // Compute which layers are handled by the xfade chain (the first N sequential media layers)
  const xfadeLayerIds = new Set(xfadeMediaLayers.map(l => l.id));
  const remainingVisual = visualLayers.filter(l => !xfadeLayerIds.has(l.id));

  if (useXfade) {
    const xfadeResult = buildXfadeChain(xfadeMediaLayers, tl.transitions!, inputs, tl.canvas, tl.canvas.fps);
    videoFilterParts.push(...xfadeResult.parts);
    xfadeBaseLabel = xfadeResult.baseLabel;
  }

  if (!hasVisual) {
    // Audio-only: use the color background as base
    videoFilterParts.push(`[${canvasBgIdx}:v]format=yuv420p[base]`);
  } else if (useXfade) {
    // xfade chain output is the base; format it
    videoFilterParts.push(`[${xfadeBaseLabel}]format=yuv420p[base]`);
  } else {
    // Start [base] from the first visual layer
    const first = visualLayers[0];

    if (first.type === "video" || first.type === "image") {
      const srcIdx = getInputIndex(first, inputs);
      const chain = buildLayerVideoChain(first, srcIdx, tl.canvas, duration);
      videoFilterParts.push(`${chain}[base]`);
    } else {
      const chain = buildLayerVideoChain(first, canvasBgIdx, tl.canvas, duration);
      videoFilterParts.push(`${chain}[base]`);
    }
  }

  // ── Composite remaining visual layers on top of [base] ──────────────────
  const layersToComposite = useXfade ? remainingVisual : visualLayers.slice(1);
  for (const layer of layersToComposite) {
    const pos = resolvePosition(layer.position, layer.size, tl.canvas);
    const opacity = layer.opacity ?? 1;
    const start = layer.start;
    const end = start + layer.duration;

    if (layer.type === "text" || layer.type === "shape") {
      let filter = `[base]`;

      if (layer.type === "text") {
        const text = layer.content.replace(/'/g, "'\\''").replace(/:/g, "\\:");
        const fontSize = layer.fontSize ?? 48;
        const textColor = layer.color ?? "#FFFFFF";
        const alignMap: Record<string, string> = { left: "L", center: "C", right: "R" };
        const ffAlign = alignMap[layer.align ?? "center"] ?? "C";
        filter += `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${textColor}:x=${pos.x}:y=${pos.y}:align=${ffAlign}:enable='between(t\\,${start}\\,${end})'`;
        if (layer.stroke) {
          filter += `:borderw=${layer.stroke.width}:bordercolor=${layer.stroke.color}`;
        }
      } else {
        const size = layer.size!;
        const fill = layer.fill ?? "#FFFFFF";
        filter += `drawbox=x=${pos.x}:y=${pos.y}:w=${size.width}:h=${size.height}:color=${fill}:t=fill:enable='between(t\\,${start}\\,${end})'`;
      }

      if (opacity < 1) {
        filter += `,format=rgba,colorchannelmixer=aa=${opacity}`;
      }

      const animFilters = buildAnimationFilters(layer, pos, layer.size ?? { width: 0, height: 0 });
      if (animFilters) filter += `,${animFilters}`;

      filter += `[base]`;
      videoFilterParts.push(filter);
    } else {
      // Video/image layers: overlay compositing with optional slide animations
      const srcIdx = getInputIndex(layer, inputs);
      let chain = buildLayerVideoChain(layer, srcIdx, tl.canvas, duration);
      if (opacity < 1) {
        chain += `,format=rgba,colorchannelmixer=aa=${opacity}`;
      }
      const animFilters = buildAnimationFilters(layer, pos, layer.size!);
      const overlayExpr = buildOverlayExpr(layer, pos, tl.canvas);
      videoFilterParts.push(
        `[base]${chain}${overlayExpr}:enable='between(t\\,${start}\\,${end})'${animFilters ? "," + animFilters : ""}[base]`
      );
    }
  }

  // Subtitles overlay
  if (tl.subtitles) {
    videoFilterParts.push(`[base]subtitles=${tl.subtitles.source}:force_style='FontSize=48,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2'[base]`);
  }

  // Audio mixing
  const audioInputs = inputs.filter(i => i.type === "audio");
  if (audioInputs.length > 0) {
    for (const input of audioInputs) {
      const audio = tl.audio.find(a => a.source === input.path)!;
      const vol = audio.volume ?? 1;
      const start = audio.start ?? 0;
      const dur = audio.duration ?? duration;
      const loopFlag = input.loop ? ",aloop=loop=-1:size=0" : "";
      audioFilterParts.push(`[${input.index}:a]atrim=start=${start}:duration=${dur},asetpts=PTS-STARTPTS,volume=${vol}${loopFlag}[a${input.index}]`);
    }
    const labels = audioInputs.map(i => `[a${i.index}]`).join("");
    audioFilterParts.push(`${labels}amix=inputs=${audioInputs.length}:duration=first:dropout_transition=0[aout]`);
  }

  // Compose filter_complex
  const filterComplex = [...videoFilterParts, ...audioFilterParts].join(";");
  args.push("-filter_complex", filterComplex);

  // Map outputs
  args.push("-map", "[base]");
  if (audioInputs.length > 0) {
    args.push("-map", "[aout]");
  } else {
    args.push("-an");
  }

  // Encoding settings
  args.push(
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-r", String(tl.canvas.fps),
    "-s", `${tl.canvas.width}x${tl.canvas.height}`,
    "-t", String(duration),
    "-c:a", "aac",
    "-b:a", "192k",
    "-y",
    outputPath,
  );

  return args;
}

// ── xfade Transition Chain ─────────────────────────────────────────────────

function buildXfadeChain(
  layers: TimelineLayer[],
  transitions: { type: string; duration: number }[],
  inputs: InputSlot[],
  canvas: { width: number; height: number },
  _fps: number,
): { parts: string[]; baseLabel: string } {
  const parts: string[] = [];
  let prevLabel = "";

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const srcIdx = getInputIndex(layer, inputs);
    const layerDur = layer.duration;
    const label = `v${i}`;

    // Prepare this layer as a full-frame stream (normalised to start at t=0)
    let chain = `[${srcIdx}:v]`;
    if (layer.type === "image") {
      chain += `loop=1:1:1,trim=duration=${layerDur},setpts=PTS-STARTPTS`;
    } else {
      chain += `trim=${layer.start}:${layer.start + layerDur},setpts=PTS-STARTPTS`;
    }
    // Scale to fill canvas preserving aspect ratio (centered)
    chain += `,scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;
    chain += `[${label}]`;
    parts.push(chain);

    if (i === 0) {
      prevLabel = label;
      continue;
    }

    const prevLayer = layers[i - 1];
    const t = transitions[Math.min(i - 1, transitions.length - 1)];
    const xfadeDur = Math.min(t.duration, prevLayer.duration, layer.duration);
    const xfadeType = t.type === "fade" ? "fade"
      : t.type === "slide" ? "slideright"
      : t.type === "wipe" ? "wipeleft"
      : "fade";
    // Offset: time in the first (previous) stream where the transition begins.
    // Both streams are normalised to start at 0, so offset = previous duration - xfade duration.
    const offset = Math.max(0, prevLayer.duration - xfadeDur);

    const xlabel = `xf${i - 1}`;
    parts.push(`[${prevLabel}][${label}]xfade=transition=${xfadeType}:duration=${xfadeDur}:offset=${offset}[${xlabel}]`);
    prevLabel = xlabel;
  }

  return { parts, baseLabel: prevLabel };
}

// ── Animated Overlay Expression ─────────────────────────────────────────────

/**
 * Build an overlay string with optional slide-in / slide-out animation.
 * Multiple slide animations on the same axis are composed (nested conditions)
 * rather than overwritten. Off-screen positions are computed relative to
 * actual canvas dimensions instead of a hardcoded sentinel.
 *
 * Returns a complete overlay filter fragment like:
 *   ,overlay=x='…':y='…'
 */
function buildOverlayExpr(
  layer: TimelineLayer,
  pos: TimelinePosition,
  canvas: { width: number; height: number },
): string {
  if (!layer.animations || layer.animations.length === 0) {
    return `,overlay=${pos.x}:${pos.y}`;
  }

  const size = layer.size!;
  const st = layer.start;
  const end = st + layer.duration;

  // Partition slide animations by the axis they affect
  const xAnims: TimelineAnimation[] = [];
  const yAnims: TimelineAnimation[] = [];
  for (const anim of layer.animations) {
    if (anim.type !== "slidein" && anim.type !== "slideout") continue;
    const dir = anim.direction ?? "left";
    if (dir === "left" || dir === "right") {
      xAnims.push(anim);
    } else {
      yAnims.push(anim);
    }
  }

  function buildAxisExpr(
    resting: number,
    anims: TimelineAnimation[],
    dim: "x" | "y",
  ): string {
    if (anims.length === 0) return String(resting);

    const edge = dim === "x" ? canvas.width : canvas.height;
    const dimSize = dim === "x" ? size.width : size.height;

    // Sort earliest first so we can wrap inside-out (latest wraps earliest)
    const sorted = [...anims].sort((a, b) => {
      const aStart = a.type === "slidein" ? st : end - a.duration;
      const bStart = b.type === "slidein" ? st : end - b.duration;
      return aStart - bStart;
    });

    let expr = String(resting);
    // Reverse: apply latest-in-time first so it becomes the outermost condition
    for (const anim of sorted.reverse()) {
      const d = anim.duration;
      const dir = anim.direction ?? (dim === "x" ? "left" : "top");
      const toLeftOrTop = dir === "left" || dir === "top";

      if (anim.type === "slidein") {
        const from = toLeftOrTop ? -dimSize : edge + dimSize;
        expr = `if(between(t\\,${st}\\,${st + d})\\,${from}+(${resting - from})*(t-${st})/${d}\\,${expr})`;
      } else {
        // slideout
        const to = toLeftOrTop ? -dimSize : edge + dimSize;
        expr = `if(between(t\\,${end - d}\\,${end})\\,${resting}+(${to - resting})*(t-(${end - d}))/${d}\\,${expr})`;
      }
    }
    return expr;
  }

  const xExpr = buildAxisExpr(pos.x, xAnims, "x");
  const yExpr = buildAxisExpr(pos.y, yAnims, "y");

  return `,overlay=x='${xExpr}':y='${yExpr}'`;
}

// ── Animation Filters ───────────────────────────────────────────────────────

/**
 * Build filter chain for all animation types on a layer.
 * fadein/fadeout → fade filter
 * slidein/slideout → handled in buildOverlayExpr (position animation)
 * scale → scale filter with animated width
 * rotate → rotate filter with animated angle
 */
function buildAnimationFilters(
  layer: TimelineLayer,
  _pos: TimelinePosition,
  size: { width: number; height: number },
): string {
  if (!layer.animations || layer.animations.length === 0) return "";
  const filters: string[] = [];
  const st = layer.start;
  const end = st + layer.duration;

  for (const anim of layer.animations) {
    const d = anim.duration;
    switch (anim.type) {
      case "fadein":
        filters.push(`format=yuva420p,fade=t=in:st=${st}:d=${d}`);
        break;
      case "fadeout":
        filters.push(`format=yuva420p,fade=t=out:st=${end - d}:d=${d}`);
        break;
      case "slidein":
      case "slideout":
        // Handled in buildOverlayExpr — no extra filter needed here.
        break;
      case "scale": {
        const from = anim.from ?? 0.5;
        const to = anim.to ?? 1;
        filters.push(
          `scale=w='if(between(t\\,${st}\\,${st + d})\\,${size.width}*(${from}+(${to - from})*(t-${st})/${d})\\,${size.width}*${to})':h='if(between(t\\,${st}\\,${st + d})\\,${size.height}*(${from}+(${to - from})*(t-${st})/${d})\\,${size.height}*${to})':eval=frame`
        );
        break;
      }
      case "rotate": {
        const from = anim.from ?? 0;
        const to = anim.to ?? 0;
        filters.push(
          `rotate=a='if(between(t\\,${st}\\,${st + d})\\,${from}+(${to - from})*(t-${st})/${d}\\,${to})*PI/180':c=none`
        );
        break;
      }
    }
  }
  return filters.join(",");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getInputIndex(layer: TimelineLayer, inputs: InputSlot[]): number {
  if ((layer.type === "video" || layer.type === "image") && "source" in layer) {
    const slot = inputs.find(i => i.path === layer.source && i.type === layer.type);
    if (slot) return slot.index;
  }
  throw new Error(`Input not found for layer ${layer.id}`);
}

function buildLayerVideoChain(
  layer: TimelineLayer,
  inputIndex: number,
  canvas: { width: number; height: number },
  duration: number,
): string {
  const start = layer.start;
  const end = start + layer.duration;

  let chain = `[${inputIndex}:v]`;

  if (layer.type === "video" || layer.type === "image") {
    const size = layer.size!;
    chain += `trim=${start}:${end},setpts=PTS-STARTPTS,scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,setsar=1`;
    if (layer.type === "image") {
      chain += `,format=yuv420p`;
    }
  } else if (layer.type === "text") {
    const text = layer.content.replace(/'/g, "'\\''").replace(/:/g, "\\:");
    const fontSize = layer.fontSize ?? 48;
    const color = layer.color ?? "#FFFFFF";
    const alignMap: Record<string, string> = { left: "L", center: "C", right: "R" };
    const ffAlign = alignMap[layer.align ?? "center"] ?? "C";
    const pos = resolvePosition(layer.position, layer.size, canvas);
    chain = `[${inputIndex}:v]drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${pos.x}:y=${pos.y}:align=${ffAlign}:enable='between(t\\,${start}\\,${end})'`;
    if (layer.stroke) {
      chain += `:borderw=${layer.stroke.width}:bordercolor=${layer.stroke.color}`;
    }
  } else if (layer.type === "shape") {
    const size = layer.size!;
    const fill = layer.fill ?? "#FFFFFF";
    const pos = resolvePosition(layer.position, layer.size, canvas);
    chain = `[${inputIndex}:v]drawbox=x=${pos.x}:y=${pos.y}:w=${size.width}:h=${size.height}:color=${fill}:t=fill:enable='between(t\\,${start}\\,${end})'`;
  }

  return chain;
}

function resolvePosition(
  position: TimelineLayer["position"],
  size: { width: number; height: number } | undefined,
  canvas: { width: number; height: number },
): TimelinePosition {
  const s = size ?? { width: 0, height: 0 };
  if (typeof position === "object") return { x: position.x, y: position.y };
  switch (position) {
    case "center": return { x: Math.round((canvas.width - s.width) / 2), y: Math.round((canvas.height - s.height) / 2) };
    case "top": return { x: Math.round((canvas.width - s.width) / 2), y: 80 };
    case "bottom": return { x: Math.round((canvas.width - s.width) / 2), y: canvas.height - s.height - 80 };
    case "left": return { x: 60, y: Math.round((canvas.height - s.height) / 2) };
    case "right": return { x: canvas.width - s.width - 60, y: Math.round((canvas.height - s.height) / 2) };
    default: return { x: 0, y: 0 };
  }
}

export { validateTimeline };
