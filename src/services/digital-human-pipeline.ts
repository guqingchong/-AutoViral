import { randomUUID } from "node:crypto";
import { getDb } from "../db/connection.js";
import * as worksRepo from "../db/works-repo.js";
import * as scriptsRepo from "../db/scripts-repo.js";
import * as avatarsRepo from "../db/avatars-repo.js";
import * as jobsRepo from "../db/digital-human-jobs-repo.js";
import * as queueRepo from "../db/work-queue-repo.js";
import { submitQueuedJob, refreshJob } from "./digital-human.js";
import { getInstanceView } from "./instance-service.js";
import { assertWithinBudget } from "./budget-service.js";
import { getDefaultProvider } from "../providers/registry.js";
import { MiniMaxTTSProvider } from "../providers/minimax-tts.js";
import { loadConfig, getConfig } from "../config.js";
import type { GenerateProvider } from "../providers/base.js";
import type { DbAvatar, DbDigitalHumanJob } from "../db/types.js";

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

// ---------------------------------------------------------------------------
// 渲染池（Task 6：攒批 + 与作品队列严格对齐）
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_THRESHOLD = 3;
/** 作品队列已空闲时，池内最久等待超过该时长即触发（避免零星任务永远等不够阈值） */
const IDLE_QUEUE_TRIGGER_MS = 10 * 60 * 1000;

/** 实例离线且池内有积压时置位，GET render-pool 返回给前端提示"去开机" */
let pendingBoot = false;
export function getPendingBoot(): boolean {
  return pendingBoot;
}

function getBatchThreshold(): number {
  const t = getConfig().digitalHuman?.batchThreshold;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.floor(t) : DEFAULT_BATCH_THRESHOLD;
}

function now(): string {
  return new Date().toISOString();
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

/** 入池位次：在作品队列中的取队列 position；不在队列的排在队尾与池尾之后 */
function nextPoolPosition(workId: string): number {
  const item = queueRepo.getItem(workId);
  if (item) return item.position;
  const db = getDb();
  const q = db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM work_queue").get() as { p: number };
  const j = db
    .prepare("SELECT COALESCE(MAX(queue_position), 0) AS p FROM digital_human_jobs WHERE status = 'queued'")
    .get() as { p: number };
  return Math.max(q.p, j.p) + 1;
}

/**
 * 按口播文案长度估算渲染成本（元）：中文 TTS ≈ 4 字/秒，10 秒起步（渲染开销下限），
 * 成本 = 时长 × GPU 时价（与 finalizeJob 的 actual_cost 口径一致）。未配置时价时为 0。
 */
export function estimateRenderCostYuan(narration: string): number {
  const rate = getConfig().heygem?.gpuHourlyRateYuan ?? 0;
  if (rate <= 0) return 0;
  const chars = narration.replace(/\s/g, "").length;
  const seconds = Math.max(chars / 4, 10);
  return Math.round(((seconds * rate) / 3600) * 10000) / 10000;
}

/**
 * 口播 TTS + 建 queued 渲染任务（不提交 HeyGem）。
 * 已有 done 任务时直接取现成产物（流水线兜底，不重复渲染）。
 */
async function prepareQueuedJobForWork(
  workId: string,
  opts?: { voice?: string }
): Promise<{ job: DbDigitalHumanJob; skipped: boolean }> {
  const existingDone = jobsRepo.listJobs(workId).find((j) => j.status === "done");
  if (existingDone) return { job: existingDone, skipped: true };

  const work = worksRepo.getWork(workId);
  if (!work) throw new Error("作品不存在");

  const avatar = resolveAvatar(work.digital_human_id);

  const script = scriptsRepo.listScriptsByWork(workId)[0];
  const narration = script ? extractNarration(script.content) : "";
  if (!narration) throw new Error("作品无脚本文案");

  // 音色优先级：显式入参 > works.voice_id > undefined（provider 默认音色，向后兼容）
  const voice = opts?.voice ?? work.voice_id;
  const tts = await getTtsProvider();
  const audio = await tts.generateAudio!({ text: narration, workId, filename: "narration.mp3", voice });
  if (!audio.success || !audio.assetPath) throw new Error(`TTS 合成失败：${audio.error ?? "未知错误"}`);

  // 入池时按口播时长估算真实成本并过预算闸；提交时 submitQueuedJob 会按该值再次断言
  const estimatedCost = estimateRenderCostYuan(narration);
  assertWithinBudget(estimatedCost);
  const job: DbDigitalHumanJob = {
    id: `dhjob_${randomUUID()}`,
    work_id: workId,
    avatar_id: avatar.id,
    audio_path: audio.assetPath,
    script_id: script?.id,
    provider: "heygem",
    status: "queued",
    progress: 0,
    estimated_cost: estimatedCost,
    actual_cost: 0,
    queue_position: nextPoolPosition(workId),
    created_at: now(),
    updated_at: now(),
  };
  jobsRepo.createJob(job);
  return { job, skipped: false };
}

/**
 * 单作品数字人口播渲染：TTS 生成口播音频 → 入渲染池（status=queued，queue_position=作品队列 position），
 * 不立即提交 HeyGem，随后检查攒批触发条件（后台 fire-and-forget，不阻塞调用方）。
 */
export async function runDigitalHumanForWork(workId: string, opts?: { voice?: string }): Promise<{ jobId: string; skipped: boolean }> {
  const { job, skipped } = await prepareQueuedJobForWork(workId, opts);
  if (!skipped) {
    void maybeTriggerRenderBatch().catch((err) => {
      console.error("[render-pool] maybeTriggerRenderBatch error:", err);
    });
  }
  return { jobId: job.id, skipped };
}

/**
 * 攒批触发检查（先到先触发）：
 *   a) 池内 queued ≥ config.digitalHuman.batchThreshold（默认 3）
 *   b) 作品队列已无 queued/running 且池内最久等待 > 10 分钟
 * 手动触发走 triggerRenderNow()。
 * 返回触发的批次状态；未触发返回 null。已有批次在跑时不重复触发。
 */
export async function maybeTriggerRenderBatch(): Promise<BatchState | null> {
  if (batchState.running) return null;
  const pool = jobsRepo.listQueuedJobsByPosition();
  if (pool.length === 0) return null;

  const queueBusy = queueRepo.listQueue().some((i) => i.status === "queued" || i.status === "running");
  const oldest = pool.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
  const waitedMs = Date.now() - Date.parse(oldest.created_at);

  if (pool.length >= getBatchThreshold() || (!queueBusy && waitedMs > IDLE_QUEUE_TRIGGER_MS)) {
    return triggerRenderNow();
  }
  return null;
}

/**
 * 手动立即渲染：集中提交池内 queued 任务并轮询完成（条件 c）。
 * 并发安全：in-flight Promise 缓存 —— 批次运行期间的并发触发共享同一批次，
 * 不会重复提交同一批 queued 任务。
 */
let activeBatch: Promise<BatchState> | null = null;

export function triggerRenderNow(): Promise<BatchState> {
  activeBatch ??= executeRenderBatch().finally(() => {
    activeBatch = null;
  });
  return activeBatch;
}

/**
 * 实例上线通知（instance-service 探测到 offline→ready 跳变时调用）：
 * 无论是否达到触发条件都先清 pendingBoot（避免前端残留"去开机"），再检查攒批触发。
 */
export async function onInstanceReady(): Promise<void> {
  pendingBoot = false;
  await maybeTriggerRenderBatch();
}

/**
 * 渲染池同步（队列变更后由队列路由调用）：
 * - 按 work_queue position 重排 queued 任务的 queue_position（paused 作品同样重排，仅提交时跳过）
 * - 作品已移出队列的任务取消（status=failed，遵循表现有状态值）
 */
export function syncRenderPool(): void {
  const pool = jobsRepo.listQueuedJobsByPosition();
  for (const job of pool) {
    if (!job.work_id) continue;
    const item = queueRepo.getItem(job.work_id);
    if (!item) {
      jobsRepo.updateJob(job.id, { status: "failed", error: "作品已移出队列，渲染取消" });
    } else if (job.queue_position !== item.position) {
      jobsRepo.updateJob(job.id, { queue_position: item.position });
    }
  }
}

export interface RenderPoolItem {
  jobId: string;
  workId: string;
  title: string;
  queuePosition: number | null;
  status: DbDigitalHumanJob["status"];
}

/** 渲染池现状：queued 任务按 queue_position 排序 */
export function getRenderPool(): RenderPoolItem[] {
  return jobsRepo.listQueuedJobsByPosition().map((j) => ({
    jobId: j.id,
    workId: j.work_id ?? "",
    title: j.work_id ? (worksRepo.getWork(j.work_id)?.title ?? "") : "",
    queuePosition: j.queue_position ?? null,
    status: j.status,
  }));
}

/** 集中提交池内 queued 任务（按 queue_position 顺序）并轮询完成。实例离线时不提交，置 pendingBoot */
async function executeRenderBatch(opts?: { intervalMs?: number; timeoutMs?: number }): Promise<BatchState> {
  // 原子置位先于任何 await：并发触发在第一步就被拦截，杜绝双批次重复提交同一批任务
  if (batchState.running) return getBatchState();
  batchState.running = true;

  const intervalMs = opts?.intervalMs ?? 10_000;
  const timeoutMs = opts?.timeoutMs ?? 3_600_000; // 60 分钟总上限

  batchState.total = 0;
  batchState.submitted = 0;
  batchState.done = 0;
  batchState.failed = 0;
  batchState.startedAt = now();
  batchState.errors = [];

  // jobId -> workId（仅跟踪本次提交/接管的 running 任务）
  const pending = new Map<string, string>();

  try {
    const view = await getInstanceView();
    if (view.state !== "ready") {
      if (jobsRepo.listQueuedJobsByPosition().length > 0) pendingBoot = true;
      return getBatchState();
    }
    pendingBoot = false;

    const pool = jobsRepo.listQueuedJobsByPosition();
    // total 只计实际会提交的任务（paused 跳过不计），避免进度对不上
    const submittable = pool.filter((job) => {
      const item = job.work_id ? queueRepo.getItem(job.work_id) : undefined;
      return item?.status !== "paused";
    });
    batchState.total = submittable.length;

    for (const job of submittable) {
      try {
        await submitQueuedJob(job.id);
        batchState.submitted++;
        pending.set(job.id, job.work_id ?? "");
      } catch (err) {
        // 复查当前状态：仅当仍是 queued 才标 failed ——
        // 若已被并发路径提交（running）或完成（done），错标 failed 会把已付费渲染判为失败
        const current = jobsRepo.getJob(job.id);
        if (!current || current.status === "queued") {
          batchState.failed++;
          batchState.errors.push({ workId: job.work_id ?? "", error: (err as Error).message });
          if (current) jobsRepo.updateJob(job.id, { status: "failed", error: (err as Error).message });
        } else if (current.status === "running") {
          batchState.submitted++;
          pending.set(job.id, job.work_id ?? "");
        } else if (current.status === "done") {
          batchState.done++;
        }
      }
    }

    await pollPendingJobs(pending, intervalMs, timeoutMs);
  } finally {
    batchState.running = false;
  }

  return getBatchState();
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

/** 统一轮询直至 pending 中任务全部 done/failed 或超时（渲染池批次与旧批量入口共用） */
async function pollPendingJobs(pending: Map<string, string>, intervalMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [jobId, workId] of [...pending]) {
      try {
        const job = await refreshJob(jobId);
        if (job?.status === "done") {
          if (workId && job.result_local_path) registerWorkAsset(workId, job.result_local_path);
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
}

/**
 * 批量渲染（旧入口保留）：为所有待渲染作品建池任务并立即集中提交（实例串行消化），
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
  batchState.startedAt = now();
  batchState.errors = [];

  // jobId -> workId（仅跟踪本次新提交的任务；skipped 的直接计入 done）
  const pending = new Map<string, string>();

  try {
    const works = await listPendingWorks();
    batchState.total = works.length;

    for (const work of works) {
      try {
        const { job, skipped } = await prepareQueuedJobForWork(work.id);
        if (skipped) {
          batchState.submitted++;
          batchState.done++;
          continue;
        }
        await submitQueuedJob(job.id);
        batchState.submitted++;
        pending.set(job.id, work.id);
      } catch (err) {
        batchState.failed++;
        batchState.errors.push({ workId: work.id, error: (err as Error).message });
      }
    }

    await pollPendingJobs(pending, intervalMs, timeoutMs);
  } finally {
    batchState.running = false;
  }

  return getBatchState();
}
