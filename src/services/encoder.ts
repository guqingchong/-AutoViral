/**
 * 视频编码器探测与参数选型(2026-09-03 批次4:nvenc GPU 编码接入;后续批次:R1 qsv 核显编码接入)。
 *
 * 背景:全链路 CPU libx264,长视频合成实测 38 分钟纯等;本机 NVIDIA 显卡可用
 * h264_nvenc 提速 5-10 倍。本模块负责"nvenc/qsv 是否真实可用"的一次性探测与参数产出。
 *
 * 已接入:src/services/long-tasks.ts(burn/tpad 等重编码 op,2026-09-07 X12 修复接线)、
 *         packages/code-scene/web-worker.mjs(内联同款最小探测,独立进程无法 import src/;
 *         2026-09-07 X12 补齐——此前头注释虚标"已接入",实际仍硬编码 libx264)、
 *         src/video/renderer.ts + src/services/conform.ts(成片编码接入,含硬件失败回退 CPU)。
 * 待后续接入(其他批次所有,本批次禁止修改):
 *   - src/server/api.ts      —— API 层编码器状态展示/日志
 *
 * 强制覆盖:AUTOVIRAL_ENCODER=cpu|qsv|nvenc|auto(默认 auto;cpu/qsv/nvenc 时跳过探测直接信任)。
 * Windows 注意:spawn ffmpeg 必须 shell:false(默认),否则参数带引号时被 cmd 二次解析。
 */

import { spawn } from "node:child_process";

/** CPU 兜底参数:与原全链路参数完全一致(libx264 veryfast crf18) */
export const CPU_VIDEO_ARGS = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
] as const;

/**
 * nvenc 参数:nvenc 没有 crf 概念,用 -rc vbr + -cq 19(约当 x264 crf18 主观质量);
 * -preset p4 是速度/质量均衡档(p1 最快 p7 最慢最清晰)。
 * 产物用于抖音/小红书分发,yuv420p 必须(平台对 10bit/444 兼容性差)。
 */
export const NVENC_VIDEO_ARGS = [
  "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "19", "-pix_fmt", "yuv420p",
] as const;

/**
 * QSV(Intel 核显硬件编码)参数:ICQ(Intelligent Constant Quality)是 Intel 版 CRF 等价物,
 * -global_quality 22 近似 x264 crf18 主观质量;-look_ahead 1 开启前瞻 -qsv_brc ICQ 绑定 ICQ 码控;
 * -g 60 + -flags +cgop 固定封闭 GOP,保证分段产物 concat 前码流可无缝拼接(对应施工图注意事项)。
 * 产物用于抖音/小红书分发,yuv420p 必须。
 */
export const QSV_VIDEO_ARGS = [
  "-c:v", "h264_qsv", "-global_quality", "22", "-look_ahead", "1", "-qsv_brc", "ICQ",
  "-preset", "medium", "-g", "60", "-flags", "+cgop", "-pix_fmt", "yuv420p",
] as const;

/** 进程级探测缓存:auto 模式下只探测一次(列表 + 试编码两次 spawn 也是成本) */
let nvencCache: boolean | null = null;
let qsvCache: boolean | null = null;

/** 测试专用:清空探测缓存(生产代码不应调用) */
export function resetEncoderCache(): void {
  nvencCache = null;
  qsvCache = null;
}

interface RunResult {
  code: number | null;
  out: string;
}

/** spawn 并收集 stdout+stderr,error/退出统一归一为 Promise(不 reject) */
function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:false 是 spawn 默认值,此处显式写出以防后来者改坏(Windows 引号陷阱)
      child = spawn(bin, args, { shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: String(err) });
      return;
    }
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { out += d.toString("utf8"); });
    child.on("error", (err) => resolve({ code: -1, out: out + String(err) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * 探测 h264_nvenc 是否真实可用:
 * 1) `ffmpeg -hide_banner -encoders` 列表里存在 h264_nvenc;
 * 2) 再用 1 秒黑场试编码验证驱动真实可用——有些机器 ffmpeg 编译进了 nvenc
 *    但无 N 卡/驱动太旧,列得出却跑不起来。
 * auto 模式下进程内只探测一次;cpu/nvenc 强制覆盖时不探测直接返回。
 */
export async function detectNvenc(ffmpegPath = "ffmpeg"): Promise<boolean> {
  const mode = (process.env.AUTOVIRAL_ENCODER ?? "auto").trim().toLowerCase();
  if (mode === "cpu") return false;
  if (mode === "nvenc") return true;
  if (nvencCache !== null) return nvencCache;

  const list = await run(ffmpegPath, ["-hide_banner", "-encoders"]);
  if (list.code !== 0 || !/\bh264_nvenc\b/.test(list.out)) {
    nvencCache = false;
    return false;
  }
  const trial = await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=black:s=256x256:d=1",
    "-c:v", "h264_nvenc", "-f", "null", "-",
  ]);
  nvencCache = trial.code === 0;
  return nvencCache;
}

/**
 * 探测 h264_qsv(Intel 核显 / QSV)是否真实可用,逻辑同 detectNvenc:
 * 1) `ffmpeg -hide_banner -encoders` 列表里存在 h264_qsv;
 * 2) 再用 1 秒黑场试编码验证核心驱动真实可用——ffmpeg 编译进 qsv 但
 *    核显驱动过旧/缺失时,列得出却跑不起来。
 * auto 模式下进程内只探测一次;cpu/qsv 强制覆盖时不探测直接返回。
 */
export async function detectQsv(ffmpegPath = "ffmpeg"): Promise<boolean> {
  const mode = (process.env.AUTOVIRAL_ENCODER ?? "auto").trim().toLowerCase();
  if (mode === "cpu") return false;
  if (mode === "qsv") return true;
  if (qsvCache !== null) return qsvCache;

  const list = await run(ffmpegPath, ["-hide_banner", "-encoders"]);
  if (list.code !== 0 || !/\bh264_qsv\b/.test(list.out)) {
    qsvCache = false;
    return false;
  }
  const trial = await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=black:s=256x256:d=1",
    "-c:v", "h264_qsv", "-f", "null", "-",
  ]);
  qsvCache = trial.code === 0;
  return qsvCache;
}

/**
 * 产出当前可用编码器的 ffmpeg 视频参数。
 * 探测顺序 qsv(Intel 核显,本机命中)→ nvenc(N 卡)→ cpu 兜底。
 * opts.forWeb: 预留给 web 分发场景的参数微调位(目前 qsv/nvenc/cpu 三分支产物均为 yuv420p,暂无差异)。
 */
export async function videoEncoderArgs(opts: { forWeb?: boolean } = {}): Promise<string[]> {
  void opts;
  if (await detectQsv()) return [...QSV_VIDEO_ARGS];
  if (await detectNvenc()) return [...NVENC_VIDEO_ARGS];
  return [...CPU_VIDEO_ARGS];
}

/**
 * 供日志/UI 显示的当前编码器名。同步函数:auto 且尚未探测时返回待探测标记,
 * 真正探测在首次 videoEncoderArgs()/detectQsv()/detectNvenc() 时发生。
 * 优先级与 videoEncoderArgs 一致:qsv > nvenc > cpu。
 */
export function currentEncoderName(): string {
  const mode = (process.env.AUTOVIRAL_ENCODER ?? "auto").trim().toLowerCase();
  if (mode === "cpu") return "libx264(forced)";
  if (mode === "qsv") return "h264_qsv(forced)";
  if (mode === "nvenc") return "h264_nvenc(forced)";
  if (qsvCache === true) return "h264_qsv";
  if (nvencCache === true) return "h264_nvenc";
  if (qsvCache === false) return "libx264";
  if (nvencCache === false) return "libx264";
  return "libx264(auto,待探测)";
}
