/**
 * 长任务作业化(2026-08-28 批次9.5,v2-M3)。
 *
 * 模式照抄 render-jobs:POST 提交即返 taskId,后台 spawn 执行,GET 轮询状态。
 * 首个接入点:whisper ASR(caption_generate.py --input)——此前在 Bash 工具里同步跑,
 * 600s 上限杀长转写(whisper medium ×3 烧 40min 事故的结构性根源)。
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, appendFile } from "node:fs/promises";
import { getDb } from "../db/connection.js";
import { dataDir } from "../config.js";
import { broadcastProgress } from "./progress-events.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.platform === "win32" ? "py" : "python3";
const PY_PREFIX = process.platform === "win32" ? ["-3"] : [];

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

  const heartbeat = setInterval(() => {
    broadcastProgress({ workId: opts.workId, kind: "system", text: `ASR 转写中(task ${id})…日志: output/${id}.log` });
    getDb().prepare("UPDATE long_tasks SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }, 30_000);
  heartbeat.unref?.();

  child.on("error", (err) => {
    clearInterval(heartbeat);
    getDb().prepare("UPDATE long_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(`spawn 失败: ${err.message}`, new Date().toISOString(), id);
  });
  child.on("close", (code) => {
    clearInterval(heartbeat);
    const ok = code === 0 && existsSync(opts.outputPath);
    getDb().prepare("UPDATE long_tasks SET status = ?, error = ?, output_json = ?, updated_at = ? WHERE id = ?")
      .run(
        ok ? "done" : "failed",
        ok ? null : `退出码 ${code}(日志: output/${id}.log)`,
        ok ? JSON.stringify({ outputPath: opts.outputPath }) : null,
        new Date().toISOString(),
        id,
      );
    broadcastProgress({
      workId: opts.workId,
      kind: "system",
      text: ok ? `✅ ASR 转写完成:${opts.outputPath}` : `❌ ASR 转写失败(退出码 ${code}),日志 output/${id}.log`,
    });
  });

  return getLongTask(id)!;
}
