/**
 * 出片质量门禁(2026-08-14 精品化内在能力)。
 *
 * 渲染完成后自动对成片做机器可检的质量检查,输出 通过/警告/失败 三级报告:
 *   - 硬指标:时长、分辨率、帧率、音轨有无、响度(静音检测)
 *   - 画面健康:黑帧段(blackdetect)、冻结帧(freezedetect,主机位卡死)
 *   - 内容规范:字幕文件覆盖率
 *
 * 定位:机器能查的交给机器,把"低级错误"(静音、黑屏、卡死、缺字幕)
 * 拦截在发布前;审美层面的评估仍由 content-evaluator 的 LLM 评审负责。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { probeMedia } from "../video/ffmpeg.js";

const execFileAsync = promisify(execFile);

export type CheckLevel = "pass" | "warn" | "fail";

export interface QualityCheck {
  key: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface QualityReport {
  videoPath: string;
  passed: boolean;
  score: number; // 0-100:pass=满分,warn 减半,fail 零分(按项平均)
  checks: QualityCheck[];
  createdAt: string;
}

async function ffmpegDetect(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, { timeout: 120_000 });
    return stderr;
  } catch (e) {
    // ffmpeg 检测类命令以非零退出属正常(无输出文件)
    return (e as { stderr?: string }).stderr ?? "";
  }
}

/** 平均响度(volumedetect):无声/接近无声返回 null */
async function meanVolume(path: string): Promise<number | null> {
  const stderr = await ffmpegDetect(["-i", path, "-af", "volumedetect", "-f", "null", "-"]);
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

/** 黑帧段(blackdetect):返回超过阈值的段列表 */
async function blackSegments(path: string): Promise<string[]> {
  const stderr = await ffmpegDetect(["-i", path, "-vf", "blackdetect=d=1.5:pix_th=0.10", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/blackdetect.*black_start:[\d.]+ black_end:[\d.]+ black_duration:[\d.]+/g)].map((m) => m[0]);
}

/** 冻结段(freezedetect):返回冻结段列表 */
async function freezeSegments(path: string): Promise<string[]> {
  const stderr = await ffmpegDetect(["-i", path, "-vf", "freezedetect=n=0.003:d=3", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/freeze_start:[\d.]+/g)].map((m) => m[0]);
}

export async function runQualityGate(videoPath: string, opts?: { subtitlePath?: string; expectedWidth?: number; expectedHeight?: number; expectAudio?: boolean }): Promise<QualityReport> {
  const checks: QualityCheck[] = [];
  const add = (key: string, label: string, level: CheckLevel, detail: string) => checks.push({ key, label, level, detail });
  // 中间段(模板图解/无声片段)不强制音轨;成片默认 expectAudio=true
  const expectAudio = opts?.expectAudio !== false;

  if (!existsSync(videoPath)) {
    return { videoPath, passed: false, score: 0, createdAt: new Date().toISOString(), checks: [{ key: "exists", label: "文件存在", level: "fail", detail: "成片文件不存在" }] };
  }

  const info = await probeMedia(videoPath);

  // 1. 时长
  const dur = info.duration ?? 0;
  if (dur <= 0) add("duration", "时长", "fail", "无法读取时长");
  else if (dur < 5) add("duration", "时长", "warn", `${dur.toFixed(1)}s 过短,平台分发价值低`);
  else if (dur > 600) add("duration", "时长", "warn", `${(dur / 60).toFixed(1)} 分钟偏长,短视频建议 ≤3 分钟`);
  else add("duration", "时长", "pass", `${dur.toFixed(1)}s`);

  // 2. 分辨率
  if (info.width && info.height) {
    const expected = opts?.expectedWidth && opts?.expectedHeight;
    if (expected && (info.width !== opts.expectedWidth || info.height !== opts.expectedHeight)) {
      add("resolution", "分辨率", "warn", `${info.width}x${info.height},与模板画布 ${opts.expectedWidth}x${opts.expectedHeight} 不一致`);
    } else if (info.width < 720) add("resolution", "分辨率", "warn", `${info.width}x${info.height} 低于 720p`);
    else add("resolution", "分辨率", "pass", `${info.width}x${info.height}`);
  } else {
    add("resolution", "分辨率", "fail", "无视频流");
  }

  // 3. 音轨 + 响度
  if (!info.hasAudio) {
    if (expectAudio) add("audio", "音轨", "fail", "成片没有音轨(无声视频)");
    else add("audio", "音轨", "pass", "无声段(模板图解/中间段),按预期无音轨");
  } else {
    const vol = await meanVolume(videoPath);
    if (vol === null) add("audio", "响度", "warn", "响度检测失败");
    else if (vol < -60) add("audio", "响度", "fail", `平均响度 ${vol.toFixed(1)}dB,接近静音`);
    else if (vol < -45) add("audio", "响度", "warn", `平均响度 ${vol.toFixed(1)}dB 偏低`);
    else add("audio", "响度", "pass", `平均响度 ${vol.toFixed(1)}dB`);
  }

  // 4. 黑帧
  const blacks = await blackSegments(videoPath);
  if (blacks.length === 0) add("blackframe", "黑帧", "pass", "无超过 1.5s 的黑帧段");
  else add("blackframe", "黑帧", "fail", `检出 ${blacks.length} 段黑帧:${blacks[0]}`);

  // 5. 冻结帧
  const freezes = await freezeSegments(videoPath);
  if (freezes.length === 0) add("freeze", "冻结帧", "pass", "无超过 3s 的画面冻结");
  else add("freeze", "冻结帧", "warn", `检出 ${freezes.length} 段画面冻结(素材短于层时长定格?)`);

  // 6. 字幕
  if (opts?.subtitlePath) {
    if (existsSync(opts.subtitlePath)) {
      const content = readFileSync(opts.subtitlePath, "utf-8");
      const entries = (content.match(/\d{2}:\d{2}:\d{2}/g) ?? []).length;
      if (entries >= 2) add("subtitle", "字幕", "pass", `字幕文件 ${entries / 2 | 0} 条`);
      else add("subtitle", "字幕", "warn", "字幕文件为空或无有效条目");
    } else {
      add("subtitle", "字幕", "fail", "声明了字幕但文件不存在");
    }
  }

  const score = checks.length === 0 ? 0
    : Math.round((checks.reduce((s, c) => s + (c.level === "pass" ? 1 : c.level === "warn" ? 0.5 : 0), 0) / checks.length) * 100);
  return {
    videoPath,
    passed: checks.every((c) => c.level !== "fail"),
    score,
    checks,
    createdAt: new Date().toISOString(),
  };
}
