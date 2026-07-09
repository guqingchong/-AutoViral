import { spawn } from "node:child_process";
import { getFFmpegPath } from "./ffmpeg.js";
import { parseFFmpegProgress } from "./progress.js";
import { validateTimeline } from "./schema.js";
import type { Timeline, TimelineLayer, TimelinePosition, TimelineAnimation, AudioTrack } from "./types.js";

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

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let killed = false;

    options.abortSignal?.addEventListener("abort", () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
      }
    });

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
      if (code === 0) {
        resolve({ outputPath: options.outputPath, duration: renderDuration });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on("error", reject);
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
  if (tl.transitions && tl.transitions.length > 0) {
    console.warn(`[renderer] transitions are declared but not yet implemented (${tl.transitions.length} transition(s) ignored)`);
  }

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

  // Categorize visual layers
  const visualLayers = tl.layers.filter(l => l.type === "video" || l.type === "image" || l.type === "text" || l.type === "shape");
  const hasVisual = visualLayers.length > 0;

  // Determine if we need an additional lavfi color background (when the first visual layer
  // is text/shape, or when there are no visual layers at all)
  const firstIsMedia = hasVisual && (visualLayers[0].type === "video" || visualLayers[0].type === "image");
  const needsCanvasBg = !hasVisual || !firstIsMedia;
  let canvasBgIdx = -1;

  if (needsCanvasBg) {
    canvasBgIdx = inputs.length;
    args.push("-f", "lavfi", "-i", `color=c=${tl.canvas.backgroundColor ?? "black"}:s=${tl.canvas.width}x${tl.canvas.height}:r=${tl.canvas.fps}:d=${duration}`);
  }

  if (!hasVisual) {
    // Audio-only: use the color background as base
    videoFilterParts.push(`[${canvasBgIdx}:v]format=yuv420p[base]`);
  } else {
    // Start [base] from the first visual layer
    const first = visualLayers[0];

    if (first.type === "video" || first.type === "image") {
      // Real media: trim/scale source into [base]
      const srcIdx = getInputIndex(first, inputs);
      const chain = buildLayerVideoChain(first, srcIdx, tl.canvas, duration);
      videoFilterParts.push(`${chain}[base]`);
    } else {
      // Text or shape first: apply drawtext/drawbox on the color background
      const chain = buildLayerVideoChain(first, canvasBgIdx, tl.canvas, duration);
      videoFilterParts.push(`${chain}[base]`);
    }

    // Remaining layers
    for (let i = 1; i < visualLayers.length; i++) {
      const layer = visualLayers[i];
      const pos = resolvePosition(layer.position, layer.size, tl.canvas);
      const opacity = layer.opacity ?? 1;
      const start = layer.start;
      const end = start + layer.duration;

      if (layer.type === "text" || layer.type === "shape") {
        // Text/shape layers chain drawtext/drawbox directly on [base] (no overlay).
        // This avoids needing transparent lavfi inputs for the overlay filter.
        let filter = `[base]`;

        if (layer.type === "text") {
          const text = layer.content.replace(/'/g, "'\\''");
          const fontSize = layer.fontSize ?? 48;
          const textColor = layer.color ?? "#FFFFFF";
          // Map user-friendly alignment to FFmpeg drawtext values
          const alignMap: Record<string, string> = { left: "L", center: "C", right: "R" };
          const ffAlign = alignMap[layer.align ?? "center"] ?? "C";
          const x = String(pos.x);
          const y = String(pos.y);
          filter += `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${textColor}:x=${x}:y=${y}:align=${ffAlign}:enable='between(t\\,${start}\\,${end})'`;
          if (layer.stroke) {
            filter += `:borderw=${layer.stroke.width}:bordercolor=${layer.stroke.color}`;
          }
        } else {
          // shape
          const size = layer.size!;
          const fill = layer.fill ?? "#FFFFFF";
          filter += `drawbox=x=${pos.x}:y=${pos.y}:w=${size.width}:h=${size.height}:color=${fill}:t=fill:enable='between(t\\,${start}\\,${end})'`;
        }

        if (opacity < 1) {
          filter += `,format=rgba,colorchannelmixer=aa=${opacity}`;
        }

        // Fade animations for text/shape (applied to entire frame)
        const fade = buildFadeFilter(layer);
        if (fade) {
          // Remove leading colon and optional format= prefix, keep the fade filter chain
          const cleanFade = fade.replace(/^:([^,]+,\s*)?/, ",");
          filter += `,format=yuva420p${cleanFade}`;
        }

        filter += `[base]`;
        videoFilterParts.push(filter);
      } else {
        // Video/image layers: normal overlay compositing
        const srcIdx = getInputIndex(layer, inputs);
        const chain = buildLayerVideoChain(layer, srcIdx, tl.canvas, duration);
        const fade = buildFadeFilter(layer);
        const cleanFade = fade.replace(/^:([^,]+,\s*)?/, ",");
        videoFilterParts.push(`[base]${chain},overlay=${pos.x}:${pos.y}:enable='between(t\\,${start}\\,${end})'${cleanFade}[base]`);
      }
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
  const pos = resolvePosition(layer.position, layer.size, canvas);
  const opacity = layer.opacity ?? 1;

  let chain = `[${inputIndex}:v]`;

  if (layer.type === "video" || layer.type === "image") {
    const size = layer.size!;
    chain += `trim=${start}:${end},setpts=PTS-STARTPTS,scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,setsar=1`;
    if (layer.type === "image") {
      chain += `,format=yuv420p`;
    }
  } else if (layer.type === "text") {
    const text = layer.content.replace(/'/g, "'\\''");
    const fontSize = layer.fontSize ?? 48;
    const color = layer.color ?? "#FFFFFF";
    const alignMap: Record<string, string> = { left: "L", center: "C", right: "R" };
    const ffAlign = alignMap[layer.align ?? "center"] ?? "C";
    const x = String(pos.x);
    const y = String(pos.y);
    chain = `[${inputIndex}:v]drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}:align=${ffAlign}:enable='between(t\\,${start}\\,${end})'`;
    if (layer.stroke) {
      chain += `:borderw=${layer.stroke.width}:bordercolor=${layer.stroke.color}`;
    }
  } else if (layer.type === "shape") {
    const size = layer.size!;
    const fill = layer.fill ?? "#FFFFFF";
    chain = `[${inputIndex}:v]drawbox=x=${pos.x}:y=${pos.y}:w=${size.width}:h=${size.height}:color=${fill}:t=fill:enable='between(t\\,${start}\\,${end})'`;
  }

  if (opacity < 1) {
    chain += `,format=rgba,colorchannelmixer=aa=${opacity}`;
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

function buildFadeFilter(layer: TimelineLayer): string {
  if (!layer.animations || layer.animations.length === 0) return "";
  const filters: string[] = [];
  for (const anim of layer.animations) {
    if (anim.type === "fadein") {
      filters.push(`:format=yuva420p,fade=t=in:st=${layer.start}:d=${anim.duration}`);
    } else if (anim.type === "fadeout") {
      filters.push(`:format=yuva420p,fade=t=out:st=${layer.start + layer.duration - anim.duration}:d=${anim.duration}`);
    }
  }
  return filters.join("");
}

export { validateTimeline };
