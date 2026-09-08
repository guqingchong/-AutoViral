/**
 * 字幕预渲染烧录(改造项 R2,2026-09-03 批次;2026-09-07 验收修复)。
 *
 * 背景:renderer.ts 用 `subtitles=...:force_style=...` 滤镜,libass 对逐字 \kf
 * 逐帧重绘 bitmap,实测拖慢到 0.16x。本模块把"光栅化"移出编码临界路径:
 *  1) 先把 ASS 一次性渲染成带 alpha 的 PNG 序列(libass 只跑一遍);
 *  2) 再用 overlay 滤镜把 PNG 序列叠加回正片(overlay 是快速滤镜)。
 * 静态字幕(无 \kf)仍走原 subtitles 滤镜,路径不变,由 renderer.ts 的分支决定。
 *
 * 2026-09-07 验收修复(验收报告 B1):
 *  - 旧实现第 1 步 `ffmpeg -i subs.ass -frames:v N` 不是合法转码路径(ASS demuxer
 *    只产字幕流、无视频流可映射 image2),实测必报 "Output file does not contain
 *    any stream"。改为 lavfi 透明底 + subtitles 滤镜一次性光栅化:
 *      -f lavfi -i "color=c=black@0:s=WxH:r=fps,subtitles=..."
 *  - 第 2 步 PNG 序列补 `-framerate`(image2 默认 25fps,与正片错位),编码参数
 *    改接 encoder.ts 的 videoEncoderArgs()(QSV→NVENC→CPU),不再回落 ffmpeg 默认
 *    libx264 crf23 medium(绕过 R1 选型且质量档低于全链路 crf18)。
 *  - 调用方(renderer.ts)对本函数整体 try/catch,失败自动回退慢速 subtitles 滤镜。
 *
 * Windows 注意:ffmpeg 一律用 execFile(默认不经过 shell),避免参数带引号被 cmd 二次解析。
 * 使用后必须清理临时目录——PNG 序列按帧存一张,长片可能吃掉大量磁盘。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { videoEncoderArgs } from "./encoder.js";

const execFileAsync = promisify(execFile);

/** ffmpeg 可执行路径:环境变量 FFMPEG_PATH 优先(与 src/video/ffmpeg.ts 探测逻辑同理),否则走 PATH。 */
function getFFmpegPath(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

/** execFile 封装:stderr/stdout 聚合成 out,非 0 或子进程 error 统一抛错 */
async function run(bin: string, args: string[]): Promise<string> {
  // 收集 stderr+stdout,失败时拼进错误信息便于排查(ffmpeg 错误多半在 stderr)
  const { stdout, stderr } = await execFileAsync(bin, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout + stderr;
}

/**
 * ASS 路径转义为 ffmpeg filter 内的 filename 值。
 * filter 语法里 `:` 是选项分隔符(Windows 盘符 C: 必须转义为 C\:),
 * 反斜杠统一转正斜杠(libass/ffmpeg 均接受),再整体包单引号防空格/中文被截断。
 */
function escapeFilterFilename(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface BurnFastOptions {
  /** 正片宽度(px),决定 PNG 序列画布尺寸,必须与正片一致 */
  width: number;
  /** 正片高度(px) */
  height: number;
  /** 正片帧率,决定 color 源帧率与 PNG 序列回读帧率,必须与正片一致 */
  fps: number;
  /** B4(2026-09-08):编码参数由调用方贯通(第一段硬件失败切 CPU 后,本段必须沿用);
   *  不传则内部探测(videoEncoderArgs) */
  encArgs?: string[];
}

/**
 * 预渲染字幕并烧录到正片。
 *
 * @param video       正片视频路径(帧率/分辨率须与 opts 一致,否则 PNG 序列与原片不同帧)
 * @param assPath     ASS 字幕文件路径
 * @param out         输出视频路径
 * @param frameCount  正片总帧数,用来限定 `-frames:v`,防止 PNG 序列超出正片长度
 * @param opts        正片画布/帧率(缺省 1080x1920@30,仅兜底;调用方应总是显式传入)
 */
export async function burnSubtitlesFast(
  video: string,
  assPath: string,
  out: string,
  frameCount: number,
  opts: BurnFastOptions = { width: 1080, height: 1920, fps: 30 }
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const { width, height, fps } = opts;
  // 第 1 步:ASS → 带 alpha 的 PNG 序列(渲染进临时目录)
  //   lavfi 透明黑底 color 源 + subtitles 滤镜:libass 对每帧只绘制一次,输出 rgba;
  //   -frames:v frameCount 只光栅化正片长度需要的帧。
  const tmpDir = await mkdtemp(join(tmpdir(), "autoviral-sub-"));
  const patternPath = join(tmpDir, "sub_%05d.png");

  try {
    await run(ffmpeg, [
      "-y",
      // B5(2026-09-08):静默日志——默认 stats 进度行在长片时会撑爆 64MB maxBuffer
      // 造成假失败(进程其实成功,execFile 因缓冲溢出报错回退慢速路径白烧一遍)
      "-loglevel", "error", "-nostats",
      "-f", "lavfi",
      "-i", `color=c=black@0.0:s=${width}x${height}:r=${fps},subtitles='${escapeFilterFilename(assPath)}'`,
      "-frames:v", String(frameCount),
      "-pix_fmt", "rgba",
      patternPath,
    ]);

    // R1:overlay 合成段也走编码器选型(QSV→NVENC→CPU),不回落 ffmpeg 默认;
    // B4:调用方已给出编码参数时沿用(硬件失败知识贯通,不再二次探测连撞)
    const encArgs = opts.encArgs ?? await videoEncoderArgs();

    // 第 2 步:PNG 序列叠加回正片(overlay 快速滤镜,音轨原样拷贝)
    //   -framerate 必须显式给:image2 序列默认 25fps,与正片帧率不一致会音画错位。
    //   P4 修复:overlay 主/叠顺序——[0:v] 正片为底、[1:v] 字幕 PNG 叠上
    //   (旧写法 [1:v][0:v] 主叠颠倒,正片盖住字幕层,静默产无字幕坏片);
    //   eof_action=pass:PNG 序列短于正片时直传正片帧,不定格残影。
    await run(ffmpeg, [
      "-y",
      "-loglevel", "error", "-nostats", // B5:同第一步,防 maxBuffer 假失败
      "-i", video,
      "-framerate", String(fps),
      "-i", patternPath,
      "-filter_complex", "[0:v][1:v]overlay=0:0:eof_action=pass",
      ...encArgs,
      "-c:a", "copy",
      out,
    ]);
  } finally {
    // 无论成功与否都清理临时目录(finally 保证异常路径也不留残片)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
