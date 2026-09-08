/**
 * 合成服务化(改造项 P3,2026-09)。
 *
 * 背景:成片的 配音/BGM/字幕/分段/拼接/loudnorm/调色/烧录 此前全由 agent 逐步执行
 * ffmpeg(一次成片 215 次 LLM 调用),还反复被 30 分钟回合上限打断。
 * 本模块把这条确定性流水线下沉为服务端一条命令:agent 只做参数决策(spec),
 * 服务端按 spec 跑 拼接→调色→字幕→混音→编码 五步。
 *
 * 内部复用:
 * - R1:videoEncoderArgs()(QSV→NVENC→CPU 动态编码,成片 0.33x→3~5x)
 * - R3:buildAssHeader(preset) 字幕样式参数化
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getFFmpegPath } from "../video/ffmpeg.js";
import { videoEncoderArgs } from "./encoder.js";
import { buildAssHeader } from "./subtitle-style.js";
import { escapeFilterPath } from "../video/draw-utils.js";

export interface ConformSegment {
  /** 分段视频绝对路径（按数组顺序拼接） */
  path: string;
}

export interface ConformSpec {
  /** 分段视频（至少 1 段） */
  segments: ConformSegment[];
  /** 配音文件（可选） */
  narration?: string;
  /** BGM 文件（可选） */
  bgm?: string;
  /** ASS 字幕文件（可选） */
  subtitle?: string;
  /** 字幕样式预设（缺省 douyin-highlight） */
  subtitleStyle?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** 响度目标（LUFS） */
  loudness?: { narration?: number; bgm?: number };
  /** 调色参数 */
  color?: { contrast?: number; saturation?: number; brightness?: number };
  /** 输出路径（绝对） */
  output: string;
}

export interface ConformResult {
  output: string;
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`conform ffmpeg 失败(exit ${code}): ${stderr.slice(-500)}`));
    });
  });
}

/**
 * 确定性合成流水线:分段拼接(concat) → 调色(eq) → 字幕(subtitles) → 混音(loudnorm+amix) → 编码(QSV)。
 * segments 只取视频轨(a=0),音轨由 narration/bgm 独立提供(成片常规:画面分段 + 独立配音/BGM)。
 */
export async function conformWork(spec: ConformSpec): Promise<ConformResult> {
  if (!spec.segments?.length) throw new Error("conform spec 无分段视频(segments 为空)");
  if (!spec.output) throw new Error("conform spec 无 output 路径");

  const ffmpeg = await getFFmpegPath();
  const w = spec.width ?? 1080;
  const h = spec.height ?? 1920;
  const fps = spec.fps ?? 30;

  // 收集输入
  const args: string[] = [];
  let idx = 0;
  const segIdx: number[] = [];
  for (const seg of spec.segments) {
    if (!existsSync(seg.path)) throw new Error(`分段视频不存在: ${seg.path}`);
    args.push("-i", seg.path);
    segIdx.push(idx++);
  }
  let narrationIdx = -1;
  if (spec.narration && existsSync(spec.narration)) { args.push("-i", spec.narration); narrationIdx = idx++; }
  let bgmIdx = -1;
  if (spec.bgm && existsSync(spec.bgm)) { args.push("-i", spec.bgm); bgmIdx = idx++; }

  const filterParts: string[] = [];

  // 1. 分段统一格式 + concat
  for (let i = 0; i < segIdx.length; i++) {
    filterParts.push(
      `[${segIdx[i]}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[vseg${i}]`
    );
  }
  const concatInputs = segIdx.map((_, i) => `[vseg${i}]`).join("");
  filterParts.push(`${concatInputs}concat=n=${segIdx.length}:v=1:a=0[vcat]`);

  // 2. 调色（eq + 轻微冷色偏移，与 assembly 红线一致）
  let vlabel = "[vcat]";
  if (spec.color) {
    const c = spec.color;
    filterParts.push(
      `${vlabel}eq=contrast=${c.contrast ?? 1.06}:saturation=${c.saturation ?? 0.92}:brightness=${c.brightness ?? -0.02},colorbalance=bs=0.06[vcolored]`
    );
    vlabel = "[vcolored]";
  }

  // 3. 字幕烧录（libass；R2 PNG 预渲染路径后续按 \kf 检测接入）
  if (spec.subtitle && existsSync(spec.subtitle)) {
    const assStyle = buildAssHeader(spec.subtitleStyle ?? "douyin-highlight");
    const assPath = escapeFilterPath(spec.subtitle);
    filterParts.push(`${vlabel}subtitles=${assPath}:${assStyle}[vsub]`);
    vlabel = "[vsub]";
  }

  // 4. 混音：配音/BGM 分别 loudnorm 后 amix
  const hasNarration = narrationIdx >= 0;
  const hasBgm = bgmIdx >= 0;
  if (hasNarration) {
    filterParts.push(`[${narrationIdx}:a]loudnorm=I=${spec.loudness?.narration ?? -15}:TP=-1.5:LRA=11[anar]`);
  }
  if (hasBgm) {
    filterParts.push(`[${bgmIdx}:a]loudnorm=I=${spec.loudness?.bgm ?? -34}:TP=-3:LRA=11,aloop=loop=-1:size=0[abgm]`);
  }
  if (hasNarration && hasBgm) {
    filterParts.push(`[anar][abgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
  } else if (hasNarration || hasBgm) {
    filterParts.push(`${hasNarration ? "[anar]" : "[abgm]"}anull[aout]`);
  }

  // 5. 编码（R1：QSV→NVENC→CPU；X12 验收修复:硬件编码运行时失败回退 CPU 重试一次）
  const encArgs = await videoEncoderArgs();
  const buildFinalArgs = (enc: string[]): string[] => {
    const a = [...args];
    a.push("-filter_complex", filterParts.join(";"));
    a.push("-map", vlabel);
    if (hasNarration || hasBgm) a.push("-map", "[aout]");
    else a.push("-an");
    a.push(
      ...enc,
      "-r", String(fps),
      "-s", `${w}x${h}`,
      "-c:a", "aac",
      "-b:a", "192k",
      "-y",
      spec.output,
    );
    return a;
  };

  try {
    await runFfmpeg(ffmpeg, buildFinalArgs(encArgs));
  } catch (err) {
    if (encArgs.includes("h264_qsv") || encArgs.includes("h264_nvenc")) {
      console.warn("[conform] 硬件编码运行时失败,回退 CPU(libx264)重试:", err);
      const { CPU_VIDEO_ARGS } = await import("./encoder.js");
      await runFfmpeg(ffmpeg, buildFinalArgs([...CPU_VIDEO_ARGS]));
    } else {
      throw err;
    }
  }
  return { output: spec.output };
}
