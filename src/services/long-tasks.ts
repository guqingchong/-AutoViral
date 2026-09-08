/**
 * 长任务作业化(2026-08-28 批次9.5,v2-M3)。
 *
 * 模式照抄 render-jobs:POST 提交即返 taskId,后台 spawn 执行,GET 轮询状态。
 * 首个接入点:whisper ASR(caption_generate.py --input)——此前在 Bash 工具里同步跑,
 * 600s 上限杀长转写(whisper medium ×3 烧 40min 事故的结构性根源)。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, appendFile, rm } from "node:fs/promises";
import { getDb } from "../db/connection.js";
import { dataDir } from "../config.js";
import { broadcastProgress } from "./progress-events.js";
import { escapeFilterPath } from "../video/draw-utils.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.platform === "win32" ? "py" : "python3";
const PY_PREFIX = process.platform === "win32" ? ["-3"] : [];

/** B3(2026-09-08):长任务子进程超时上限——挂死的 ffmpeg/whisper 此前无超时永驻 running */
const ASR_TIMEOUT_MS = 60 * 60_000;   // whisper small 长片 ~20min,60min 封顶
const FFMPEG_TIMEOUT_MS = 30 * 60_000; // 单片合成实测 <15min,30min 封顶

/**
 * 子进程超时杀(进程树):超时后标记 timedOut 并杀整棵树
 * (Windows taskkill /T——bash→py→python 孙进程不杀会成孤儿)。
 * 返回解除函数,close/error 时调用。
 */
function armChildTimeout(child: ChildProcess, ms: number, onTimeout: () => void): () => void {
  const t = setTimeout(() => {
    onTimeout();
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).unref();
    } else {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }
  }, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

export interface LongTask {
  id: string;
  kind: string;
  work_id: string | null;
  status: "running" | "done" | "failed";
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: Record<string, unknown>): LongTask {
  return row as unknown as LongTask;
}

export function getLongTask(id: string): LongTask | undefined {
  const row = getDb().prepare("SELECT * FROM long_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

/**
 * 指定作品是否存在运行中的长任务(status='running' 且 work_id=?)。
 *
 * 供回合 guard 使用:后台长任务(烧字幕/渲染/ffmpeg 等)运行中时,
 * 不因回合超时打断/杀 job——只断 LLM 轮次,让 job 跑完再由回调接管。
 */
export function hasRunningLongTask(workId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM long_tasks WHERE work_id = ? AND status = 'running' LIMIT 1")
    .get(workId) as { id: string } | undefined;
  return Boolean(row);
}

// ── 任务完成回调注册(进程内 Map,2026-09 回合 guard 解耦) ──────────────
// 长任务完成/失败后除 broadcastProgress 外,通知 agent 侧注册的处理器,
// 让 agent 拿到最终 task 结果后推进下一步(回合已断、job 仍在跑的场景)。

const taskCallbacks = new Map<string, ((task: LongTask) => void)[]>();

/** 注册某类长任务的完成/失败回调(kind 精确匹配)。返回注销函数。 */
export function registerTaskCallback(kind: string, cb: (task: LongTask) => void): () => void {
  const list = taskCallbacks.get(kind) ?? [];
  list.push(cb);
  taskCallbacks.set(kind, list);
  return () => {
    const arr = taskCallbacks.get(kind);
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
    if (!arr.length) taskCallbacks.delete(kind);
  };
}

function notifyTaskCallbacks(task: LongTask): void {
  const list = taskCallbacks.get(task.kind);
  if (!list?.length) return;
  for (const cb of list) {
    try { cb(task); } catch { /* 单回调异常不阻断后续回调 */ }
  }
}

export function listLongTasks(workId?: string): LongTask[] {
  const rows = workId
    ? getDb().prepare("SELECT * FROM long_tasks WHERE work_id = ? ORDER BY created_at DESC LIMIT 50").all(workId)
    : getDb().prepare("SELECT * FROM long_tasks ORDER BY created_at DESC LIMIT 50").all();
  return (rows as Record<string, unknown>[]).map(rowToTask);
}

/** 提交 ASR 长任务:caption_generate.py --input 媒体文件 → ASS 字幕。立即返回 taskId。 */
export async function submitAsrTask(opts: {
  workId: string;
  inputPath: string;
  outputPath: string;
  model?: string;
  style?: string;
}): Promise<LongTask> {
  const id = `lt_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO long_tasks (id, kind, work_id, status, input_json, created_at, updated_at)
     VALUES (?, 'asr', ?, 'running', ?, ?, ?)`,
  ).run(id, opts.workId, JSON.stringify({ inputPath: opts.inputPath, outputPath: opts.outputPath }), now, now);

  const logPath = join(dataDir, "works", opts.workId, "output", `${id}.log`);
  await mkdir(dirname(logPath), { recursive: true });

  const script = join(PROJECT_ROOT, "skills", "content-assembly", "scripts", "caption_generate.py");
  const args = [
    ...PY_PREFIX, script,
    "--input", opts.inputPath,
    "--output", opts.outputPath,
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.style ? ["--style", opts.style] : []),
  ];
  const child = spawn(PY, args, { cwd: join(dataDir, "works", opts.workId), windowsHide: true });
  child.stdout.on("data", (d) => void appendFile(logPath, d.toString("utf8")).catch(() => {}));
  child.stderr.on("data", (d) => void appendFile(logPath, d.toString("utf8")).catch(() => {}));

  let timedOut = false;
  const disarmTimeout = armChildTimeout(child, ASR_TIMEOUT_MS, () => { timedOut = true; });

  const heartbeat = setInterval(() => {
    broadcastProgress({ workId: opts.workId, kind: "system", text: `ASR 转写中(task ${id})…日志: output/${id}.log` });
    getDb().prepare("UPDATE long_tasks SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }, 30_000);
  heartbeat.unref?.();

  child.on("error", (err) => {
    clearInterval(heartbeat);
    disarmTimeout();
    getDb().prepare("UPDATE long_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(`spawn 失败: ${err.message}`, new Date().toISOString(), id);
    notifyTaskCallbacks(getLongTask(id)!);
  });
  child.on("close", (code) => {
    clearInterval(heartbeat);
    disarmTimeout();
    const ok = code === 0 && existsSync(opts.outputPath) && !timedOut;
    getDb().prepare("UPDATE long_tasks SET status = ?, error = ?, output_json = ?, updated_at = ? WHERE id = ?")
      .run(
        ok ? "done" : "failed",
        ok ? null : timedOut ? `超时(${ASR_TIMEOUT_MS / 60_000}min)强杀(日志: output/${id}.log)` : `退出码 ${code}(日志: output/${id}.log)`,
        ok ? JSON.stringify({ outputPath: opts.outputPath }) : null,
        new Date().toISOString(),
        id,
      );
    notifyTaskCallbacks(getLongTask(id)!);
    broadcastProgress({
      workId: opts.workId,
      kind: "system",
      text: ok ? `✅ ASR 转写完成:${opts.outputPath}` : `❌ ASR 转写失败(退出码 ${code}),日志 output/${id}.log`,
    });
  });

  return getLongTask(id)!;
}

/**
 * B3(2026-09-08) zombie reaper:服务启动时把 long_tasks 残留 running 行置 failed。
 * 子进程随服务进程死亡,但 DB 行永远停在 running——hasRunningLongTask 永远为真,
 * 会反过来卡住 B3 的回合豁免/auto_continue(实证前该类行只能靠手工清库)。
 */
export function reapZombieTasks(): number {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    "UPDATE long_tasks SET status = 'failed', error = '服务重启:进程已死(zombie reaper)', updated_at = ? WHERE status = 'running'",
  ).run(now);
  return r.changes;
}

/**
 * 批量渲染长任务(2026-09-01 批次12b,系统审查效率实证):
 * agent 一次提交全部镜头渲染,服务端走 code-scene 并发池(模板 2 路),
 * 一次任务一个完成事件——消灭"单条同步 curl + sleep 轮询"(8-31 dde 实测
 * assets 阶段轮询循环吃掉 45min+ 纯等待)。
 * 在进程内异步执行(renderCodeScene 本就在进程内,池内自动排队),不 spawn。
 */
export async function submitRenderBatchTask(opts: {
  workId: string;
  renders: Array<Record<string, unknown>>;
}): Promise<LongTask> {
  const id = `lt_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO long_tasks (id, kind, work_id, status, input_json, created_at, updated_at)
     VALUES (?, 'render-batch', ?, 'running', ?, ?, ?)`,
  ).run(id, opts.workId, JSON.stringify({ count: opts.renders.length }), now, now);

  broadcastProgress({ workId: opts.workId, kind: "system", text: `批量渲染已提交:${opts.renders.length} 个镜头(task ${id}),完成时自动通知` });

  (async () => {
    const { renderCodeScene } = await import("./code-scene.js");
    const results = await Promise.allSettled(
      opts.renders.map((r) => renderCodeScene({ ...(r as object), workId: opts.workId } as never)),
    );
    const summary = results.map((r, i) => ({
      filename: (opts.renders[i] as { filename?: string }).filename ?? `render-${i}`,
      ok: r.status === "fulfilled" && (r.value as { success?: boolean }).success === true,
      url: r.status === "fulfilled" ? (r.value as { url?: string }).url : undefined,
      error: r.status === "rejected"
        ? String(r.reason)
        : (r.value as { error?: string }).error,
    }));
    const failCount = summary.filter((s) => !s.ok).length;
    getDb().prepare("UPDATE long_tasks SET status = ?, output_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(
        failCount === 0 ? "done" : "failed",
        JSON.stringify({ results: summary }),
        failCount ? `${failCount}/${summary.length} 个镜头渲染失败` : null,
        new Date().toISOString(),
        id,
      );
    notifyTaskCallbacks(getLongTask(id)!);
    broadcastProgress({
      workId: opts.workId,
      kind: "system",
      text: failCount === 0
        ? `✅ 批量渲染完成:${summary.length} 个镜头全部出片`
        : `⚠️ 批量渲染:${failCount}/${summary.length} 个失败,GET /api/long-tasks/${id} 查明细`,
    });
  })().catch((err) => {
    getDb().prepare("UPDATE long_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(String(err), new Date().toISOString(), id);
    notifyTaskCallbacks(getLongTask(id)!);
  });

  return getLongTask(id)!;
}

// ── ffmpeg 参数化长任务(2026-09-01 批次12b+,系统审查实证) ─────────────
// 设计原则:assembly 的合成烧录此前只能"Bash 后台 + sleep 轮询"(dde 实测 38min 纯等)。
// 但通用 ffmpeg 命令行是注入面——只允许白名单操作,参数=文件路径+数值,
// 命令全部由服务端拼装;所有路径必须解析在作品目录内(防越界读写)。

export interface FfmpegJobSpec {
  op: "concat" | "burn" | "loudnorm" | "tpad" | "trim";
  /** concat: 按顺序拼接的片段列表(作品目录内相对路径或绝对路径) */
  inputs?: string[];
  /** burn/loudnorm/tpad/trim 的输入视频 */
  input?: string;
  /** burn: .ass 字幕文件 */
  ass?: string;
  output: string;
  /** tpad: 末帧定格补时长(秒);trim: 截取时长(秒) */
  duration?: number;
  /** trim: 起始秒 */
  startTime?: number;
}

export function assertPathInWorkDir(workDir: string, p: string): string {
  const abs = resolve(workDir, p);
  if (abs !== workDir && !abs.startsWith(workDir + sep) && !abs.startsWith(workDir + "/")) {
    throw new Error(`路径越界(必须在作品目录内): ${p}`);
  }
  return abs;
}

/**
 * 合成长任务(X3 验收修复,2026-09-07):conform 流水线作业化。
 * 此前 POST /api/works/:id/conform 在 HTTP 请求内同步跑完——长片合成挂住请求,
 * 且正是"被 30 分钟回合上限打断"要解决的问题在服务端化后复发。
 * 现与 render-batch 同构:提交即返 taskId,进程内异步执行,完成事件注入 agent。
 */
export async function submitConformTask(opts: {
  workId: string;
  spec: import("./conform.js").ConformSpec;
}): Promise<LongTask> {
  const id = `lt_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO long_tasks (id, kind, work_id, status, input_json, created_at, updated_at)
     VALUES (?, 'conform', ?, 'running', ?, ?, ?)`,
  ).run(id, opts.workId, JSON.stringify({ output: opts.spec.output, segments: opts.spec.segments.length }), now, now);

  broadcastProgress({ workId: opts.workId, kind: "system", text: `合成流水线已提交:${opts.spec.segments.length} 个分段(task ${id}),完成时自动通知` });

  (async () => {
    const { conformWork } = await import("./conform.js");
    const result = await conformWork(opts.spec);
    getDb().prepare("UPDATE long_tasks SET status = 'done', output_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ outputPath: result.output }), new Date().toISOString(), id);
    notifyTaskCallbacks(getLongTask(id)!);
    broadcastProgress({ workId: opts.workId, kind: "system", text: `✅ 合成完成:${result.output}` });
  })().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    getDb().prepare("UPDATE long_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(msg, new Date().toISOString(), id);
    notifyTaskCallbacks(getLongTask(id)!);
    broadcastProgress({ workId: opts.workId, kind: "system", text: `❌ 合成失败(task ${id}):${msg}` });
  });

  return getLongTask(id)!;
}

/** 服务端拼装 ffmpeg 参数(纯函数,便于测试)
 *  X12(2026-09-07):重编码 op(burn/tpad)的视频参数由调用方经 videoEncoderArgs() 传入
 *  (QSV→NVENC→CPU);缺省回落 libx264 veryfast crf18,保持测试与旧调用方兼容。 */
export function buildFfmpegArgs(spec: FfmpegJobSpec, workDir: string, concatListPath: string, encArgs?: string[]): string[] {
  const videoArgs = encArgs ?? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  const inputAbs = spec.input ? assertPathInWorkDir(workDir, spec.input) : undefined;
  const outputAbs = assertPathInWorkDir(workDir, spec.output);
  switch (spec.op) {
    case "concat": {
      if (!spec.inputs?.length) throw new Error("concat 需要 inputs 数组");
      spec.inputs.forEach((p) => assertPathInWorkDir(workDir, p));
      // concat demuxer;片段同构(同一管线产出)→ 流拷贝,失败由调用方重试改重编码
      return ["-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", "-y", outputAbs];
    }
    case "burn": {
      if (!inputAbs || !spec.ass) throw new Error("burn 需要 input 与 ass");
      const assAbs = assertPathInWorkDir(workDir, spec.ass);
      return ["-i", inputAbs, "-vf", `ass='${escapeFilterPath(assAbs)}'`,
        ...videoArgs,
        "-c:a", "copy", "-y", outputAbs];
    }
    case "loudnorm": {
      if (!inputAbs) throw new Error("loudnorm 需要 input");
      return ["-i", inputAbs, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-y", outputAbs];
    }
    case "tpad": {
      if (!inputAbs || !(spec.duration! > 0)) throw new Error("tpad 需要 input 与 duration>0");
      return ["-i", inputAbs, "-vf", `tpad=stop_mode=clone:stop_duration=${spec.duration!.toFixed(3)}`,
        ...videoArgs,
        "-an", "-y", outputAbs];
    }
    case "trim": {
      if (!inputAbs) throw new Error("trim 需要 input");
      const args = ["-i", inputAbs];
      if (spec.startTime !== undefined) args.push("-ss", String(spec.startTime));
      if (spec.duration !== undefined) args.push("-t", String(spec.duration));
      args.push("-c", "copy", "-y", outputAbs);
      return args;
    }
  }
}

/** 提交 ffmpeg 长任务:立即返回 taskId,完成/失败事件推送 */
export async function submitFfmpegTask(opts: { workId: string; spec: FfmpegJobSpec }): Promise<LongTask> {
  const workDir = join(dataDir, "works", opts.workId);
  const id = `lt_${randomUUID().slice(0, 8)}`;
  const concatListPath = join(workDir, "output", `${id}.concat.txt`);
  // X12(2026-09-07,R1):重编码 op 接 QSV 硬件加速(探测失败自动回落 CPU 参数)
  const { videoEncoderArgs } = await import("./encoder.js");
  const encArgs = await videoEncoderArgs();
  // 参数校验+命令拼装在提交期完成(失败即 400,不产生垃圾任务)
  const args = buildFfmpegArgs(opts.spec, workDir, concatListPath, encArgs);

  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO long_tasks (id, kind, work_id, status, input_json, created_at, updated_at)
     VALUES (?, 'ffmpeg', ?, 'running', ?, ?, ?)`,
  ).run(id, opts.workId, JSON.stringify({ op: opts.spec.op, output: opts.spec.output }), now, now);

  const logPath = join(workDir, "output", `${id}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  if (opts.spec.op === "concat") {
    const lines = opts.spec.inputs!.map((p) => `file '${assertPathInWorkDir(workDir, p).replace(/\\/g, "/")}'`);
    await appendFile(concatListPath, lines.join("\n"), "utf-8");
  }

  const { getFFmpegPath } = await import("../video/ffmpeg.js");
  const ffmpeg = await getFFmpegPath();
  const child = spawn(ffmpeg, args, { cwd: workDir, windowsHide: true });
  child.stderr?.on("data", (d) => void appendFile(logPath, d.toString("utf8")).catch(() => {}));

  let timedOut = false;
  const disarmTimeout = armChildTimeout(child, FFMPEG_TIMEOUT_MS, () => { timedOut = true; });

  const heartbeat = setInterval(() => {
    broadcastProgress({ workId: opts.workId, kind: "system", text: `ffmpeg ${opts.spec.op} 合成中(task ${id})…` });
    getDb().prepare("UPDATE long_tasks SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }, 30_000);
  heartbeat.unref?.();

  const outAbs = resolve(workDir, opts.spec.output);
  child.on("error", (err) => {
    clearInterval(heartbeat);
    disarmTimeout();
    getDb().prepare("UPDATE long_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(`spawn 失败: ${err.message}`, new Date().toISOString(), id);
    notifyTaskCallbacks(getLongTask(id)!);
  });
  child.on("close", (code) => {
    clearInterval(heartbeat);
    disarmTimeout();
    rm(concatListPath, { force: true }).catch(() => {});
    const ok = code === 0 && existsSync(outAbs) && !timedOut;
    getDb().prepare("UPDATE long_tasks SET status = ?, error = ?, output_json = ?, updated_at = ? WHERE id = ?")
      .run(
        ok ? "done" : "failed",
        ok ? null : timedOut ? `超时(${FFMPEG_TIMEOUT_MS / 60_000}min)强杀(日志: output/${id}.log)` : `退出码 ${code}(日志: output/${id}.log)`,
        ok ? JSON.stringify({ outputPath: outAbs }) : null,
        new Date().toISOString(),
        id,
      );
    notifyTaskCallbacks(getLongTask(id)!);
    broadcastProgress({
      workId: opts.workId, kind: "system",
      text: ok ? `✅ ffmpeg ${opts.spec.op} 完成:${opts.spec.output}` : `❌ ffmpeg ${opts.spec.op} 失败(退出码 ${code}),日志 output/${id}.log`,
    });
  });

  return getLongTask(id)!;
}
