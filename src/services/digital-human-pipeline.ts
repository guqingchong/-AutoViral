import { getDb } from "../db/connection.js";
import * as worksRepo from "../db/works-repo.js";
import * as scriptsRepo from "../db/scripts-repo.js";
import * as avatarsRepo from "../db/avatars-repo.js";
import * as jobsRepo from "../db/digital-human-jobs-repo.js";
import { submitJob, refreshJob } from "./digital-human.js";
import { getDefaultProvider } from "../providers/registry.js";
import { MiniMaxTTSProvider } from "../providers/minimax-tts.js";
import { loadConfig } from "../config.js";
import type { GenerateProvider } from "../providers/base.js";
import type { DbAvatar } from "../db/types.js";

export interface BatchState {
  running: boolean;
  total: number;
  submitted: number;
  done: number;
  failed: number;
  startedAt: string | null;
  errors: Array<{ workId: string; error: string }>;
}

const batchState: BatchState = {
  running: false,
  total: 0,
  submitted: 0,
  done: 0,
  failed: 0,
  startedAt: null,
  errors: [],
};

export function getBatchState(): BatchState {
  return { ...batchState, errors: [...batchState.errors] };
}

// 脚本文案常见键（content-generator 产出 scenes[].narration，手工/其他来源可能直接给字符串字段）
const NARRATION_KEYS = ["narration", "口播", "voiceover", "voice", "text", "content"];

function firstStringByKeys(obj: Record<string, unknown>): string {
  for (const key of NARRATION_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 从 scripts.content 容错提取口播文案：纯字符串直接用；JSON 对象按常见键/scenes 提取；兜底拼接所有字符串值 */
export function extractNarration(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!content || typeof content !== "object") return "";
  const obj = content as Record<string, unknown>;

  const direct = firstStringByKeys(obj);
  if (direct) return direct;

  // 分镜脚本结构：scenes[].narration（或 scenes[] 上的其他口播键）
  if (Array.isArray(obj.scenes)) {
    const parts: string[] = [];
    for (const scene of obj.scenes) {
      if (scene && typeof scene === "object") {
        const text = firstStringByKeys(scene as Record<string, unknown>);
        if (text) parts.push(text);
      }
    }
    if (parts.length) return parts.join("\n");
  }

  // 兜底：递归拼接所有字符串值
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") { if (v.trim()) parts.push(v.trim()); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(obj);
  return parts.join("\n");
}

function resolveAvatar(workAvatarId: string | undefined): DbAvatar {
  if (workAvatarId) {
    const avatar = avatarsRepo.getAvatar(workAvatarId);
    if (avatar) return avatar;
  }
  const fallback = avatarsRepo.listAvatars().find((a) => a.config.isDefault === true);
  if (!fallback) throw new Error("未绑定形象且无默认形象");
  return fallback;
}

async function getTtsProvider(): Promise<GenerateProvider> {
  // 复用 registry 中已初始化的音频 provider（server 启动时 initProviders 注册）；
  // 未注册时（如 CLI 直跑）按 initProviders 的既有方式用 minimax 配置现场实例化
  const registered = getDefaultProvider("audio");
  if (registered?.generateAudio) return registered;
  const config = await loadConfig();
  if (!config.minimax?.apiKey) throw new Error("TTS 未配置：缺少 minimax.apiKey");
  return new MiniMaxTTSProvider(config.minimax);
}

/**
 * 单作品数字人口播渲染：TTS 生成口播音频 → 提交 HeyGem 渲染任务（只提交不等待）。
 * 已有 done 任务时直接取现成产物（流水线兜底，不重复渲染）。
 */
export async function runDigitalHumanForWork(workId: string): Promise<{ jobId: string; skipped: boolean }> {
  const existingDone = jobsRepo.listJobs(workId).find((j) => j.status === "done");
  if (existingDone) return { jobId: existingDone.id, skipped: true };

  const work = worksRepo.getWork(workId);
  if (!work) throw new Error("作品不存在");

  const avatar = resolveAvatar(work.digital_human_id);

  const script = scriptsRepo.listScriptsByWork(workId)[0];
  const narration = script ? extractNarration(script.content) : "";
  if (!narration) throw new Error("作品无脚本文案");

  const tts = await getTtsProvider();
  const audio = await tts.generateAudio!({ text: narration, workId, filename: "narration.mp3" });
  if (!audio.success || !audio.assetPath) throw new Error(`TTS 合成失败：${audio.error ?? "未知错误"}`);

  const job = await submitJob({
    workId,
    avatarId: avatar.id,
    audioUrl: audio.assetPath,
    scriptId: script?.id,
  });
  return { jobId: job.id, skipped: false };
}

/** 待渲染作品：绑定了形象、有脚本、且尚无 done 数字人任务 */
export async function listPendingWorks(): Promise<Array<{ id: string; title: string }>> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.id, w.title FROM works w
       WHERE w.digital_human_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM scripts s WHERE s.work_id = w.id)
         AND NOT EXISTS (SELECT 1 FROM digital_human_jobs j WHERE j.work_id = w.id AND j.status = 'done')
       ORDER BY w.updated_at DESC`
    )
    .all() as Array<{ id: string; title: string }>;
  return rows;
}

function registerWorkAsset(workId: string, localPath: string): void {
  const db = getDb();
  db.prepare("INSERT INTO work_assets (work_id, path, mime_type, kind) VALUES (?, ?, ?, ?)").run(
    workId,
    localPath,
    "video/mp4",
    "digital-human"
  );
}

/**
 * 批量渲染：集中提交所有待渲染作品的数字人任务（实例串行消化），
 * 然后统一轮询直至全部 done/failed。单个失败不阻断其余作品。
 * 长跑任务 —— API 层 fire-and-forget 调用，调用方通过 getBatchState 轮询进度。
 */
export async function runBatchDigitalHuman(opts?: { intervalMs?: number; timeoutMs?: number }): Promise<BatchState> {
  if (batchState.running) return getBatchState();

  const intervalMs = opts?.intervalMs ?? 10_000;
  const timeoutMs = opts?.timeoutMs ?? 3_600_000; // 60 分钟总上限

  batchState.running = true;
  batchState.total = 0;
  batchState.submitted = 0;
  batchState.done = 0;
  batchState.failed = 0;
  batchState.startedAt = new Date().toISOString();
  batchState.errors = [];

  // jobId -> workId（仅跟踪本次新提交的任务；skipped 的直接计入 done）
  const pending = new Map<string, string>();

  try {
    const works = await listPendingWorks();
    batchState.total = works.length;

    for (const work of works) {
      try {
        const { jobId, skipped } = await runDigitalHumanForWork(work.id);
        batchState.submitted++;
        if (skipped) batchState.done++;
        else pending.set(jobId, work.id);
      } catch (err) {
        batchState.failed++;
        batchState.errors.push({ workId: work.id, error: (err as Error).message });
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      for (const [jobId, workId] of [...pending]) {
        try {
          const job = await refreshJob(jobId);
          if (job?.status === "done") {
            if (job.result_local_path) registerWorkAsset(workId, job.result_local_path);
            batchState.done++;
            pending.delete(jobId);
          } else if (job?.status === "failed") {
            batchState.failed++;
            batchState.errors.push({ workId, error: job.error ?? "数字人渲染失败" });
            pending.delete(jobId);
          }
        } catch (err) {
          // 单次刷新异常不阻断批量轮询，下一轮重试
          batchState.errors.push({ workId, error: `轮询异常：${(err as Error).message}` });
        }
      }
      if (pending.size > 0) await new Promise((r) => setTimeout(r, intervalMs));
    }

    // 超时仍未完成的任务记为失败
    for (const [jobId, workId] of pending) {
      batchState.failed++;
      batchState.errors.push({ workId, error: `轮询超时（job ${jobId}）` });
    }
    pending.clear();
  } finally {
    batchState.running = false;
  }

  return getBatchState();
}
