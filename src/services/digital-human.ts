import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, getConfig } from "../config.js";
import * as heygem from "./heygem-client.js";
import { assertReady, recordActivity } from "./instance-service.js";
import * as avatarsRepo from "../db/avatars-repo.js";
import * as jobsRepo from "../db/digital-human-jobs-repo.js";
import { assertWithinBudget } from "./budget-service.js";
import type { DbAvatar, DbDigitalHumanJob } from "../db/types.js";

const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".avi"];

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

// 服务层生成的 ID 形如 avatar_<uuid> / dhjob_<uuid>；删除前校验防止 URL 中的 ../ 逃逸 dataDir
const AVATAR_ID_PATTERN = /^avatar_[0-9a-f-]+$/;
const JOB_ID_PATTERN = /^dhjob_[0-9a-f-]+$/;

export function isValidAvatarId(id: string): boolean { return AVATAR_ID_PATTERN.test(id); }
export function isValidJobId(id: string): boolean { return JOB_ID_PATTERN.test(id); }

function now(): string { return new Date().toISOString(); }

function avatarDir(id: string): string { return join(dataDir, "avatars", id); }
function avatarMediaPath(id: string, filename: string): string { return join(avatarDir(id), filename); }
function jobOutputDir(id: string): string { return join(dataDir, "digital-human-jobs", id); }
function jobOutputPath(id: string): string { return join(jobOutputDir(id), "output.mp4"); }

function publicAvatarMediaUrl(avatarId: string, filename: string): string {
  return `/api/digital-humans/avatars/${encodeURIComponent(avatarId)}/media/${encodeURIComponent(filename)}`;
}

/** HeyGem 需要本地文件：非 http 直接当作本地路径；本服务 /api/ URL 映射回 dataDir 下的文件 */
function toLocalMediaPath(pathOrUrl: string): string {
  if (!/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const pathname = new URL(pathOrUrl).pathname;
  const idx = pathname.indexOf("/api/");
  if (idx === -1) throw new Error("音频必须是本地文件路径或本服务 /api/ URL");
  const root = resolve(dataDir);
  const resolved = resolve(root, decodeURIComponent(pathname.slice(idx + "/api/".length)));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error("音频路径越界：必须位于数据目录内");
  }
  return resolved;
}

export async function createAvatarFromUpload(name: string, data: Buffer, filename: string): Promise<DbAvatar> {
  const ext = extname(filename).toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) throw new Error("形象必须是源视频文件（mp4/mov/webm/avi）");
  const id = generateId("avatar");
  await mkdir(avatarDir(id), { recursive: true });
  const safeName = `media${ext}`;
  const mediaPath = avatarMediaPath(id, safeName);
  await writeFile(mediaPath, data);
  const avatar: DbAvatar = {
    id, name,
    status: "ready",
    source: "heygem",
    reference_video_path: mediaPath,
    preview_url: publicAvatarMediaUrl(id, safeName),
    config: { originalName: filename, mediaName: safeName },
    created_at: now(),
    updated_at: now(),
  };
  avatarsRepo.createAvatar(avatar);
  return avatar;
}

export async function setDefaultAvatar(avatarId: string): Promise<DbAvatar | undefined> {
  for (const a of avatarsRepo.listAvatars()) {
    if (a.config.isDefault) avatarsRepo.updateAvatar(a.id, { config: { ...a.config, isDefault: false } });
  }
  const existing = avatarsRepo.getAvatar(avatarId);
  if (!existing) return undefined;
  return avatarsRepo.updateAvatar(avatarId, { config: { ...existing.config, isDefault: true } });
}

export async function submitJob(input: {
  workId?: string;
  avatarId: string;
  audioUrl: string;
  scriptId?: number;
  estimatedCost?: number;
}): Promise<DbDigitalHumanJob> {
  const avatar = avatarsRepo.getAvatar(input.avatarId);
  if (!avatar) throw new Error("Avatar not found");
  if (!avatar.reference_video_path) throw new Error("形象缺少源视频文件");
  assertWithinBudget(input.estimatedCost ?? 0);
  await assertReady();
  const audioPath = toLocalMediaPath(input.audioUrl);
  const providerJobId = await heygem.submitJob(audioPath, avatar.reference_video_path, "pingpong");
  const job: DbDigitalHumanJob = {
    id: generateId("dhjob"),
    work_id: input.workId,
    avatar_id: input.avatarId,
    audio_path: input.audioUrl,
    script_id: input.scriptId,
    provider: "heygem",
    status: "running",
    progress: 10,
    estimated_cost: input.estimatedCost ?? 0,
    actual_cost: 0,
    provider_job_id: providerJobId,
    created_at: now(),
    updated_at: now(),
  };
  jobsRepo.createJob(job);
  recordActivity();
  return job;
}

export async function refreshJob(jobId: string): Promise<DbDigitalHumanJob | undefined> {
  const job = jobsRepo.getJob(jobId);
  if (!job || !job.provider_job_id) return job;
  if (job.status === "done" || job.status === "failed") return job;
  let info: Awaited<ReturnType<typeof heygem.getJob>>;
  try {
    info = await heygem.getJob(job.provider_job_id);
  } catch (err) {
    // 网络等瞬时故障：保持 running 记录 error，允许后续再次 refresh（spec §10）
    return jobsRepo.updateJob(jobId, { status: "running", error: (err as Error).message });
  }
  if (info.status === "succeeded") {
    try {
      return await finalizeJob(job, info.processing_time_seconds);
    } catch (err) {
      // 结果下载失败：保持 running 记录 error，允许后续再次 refresh（spec §10）
      return jobsRepo.updateJob(jobId, { status: "running", error: (err as Error).message });
    }
  }
  if (info.status === "failed") {
    // 仅 HeyGem 侧明确返回 failed 才转 failed
    return jobsRepo.updateJob(jobId, { status: "failed", error: info.error ?? "HeyGem 任务失败" });
  }
  return jobsRepo.updateJob(jobId, { status: "running", progress: info.status === "queued" ? 10 : 50 });
}

async function finalizeJob(job: DbDigitalHumanJob, processingSeconds: number | null): Promise<DbDigitalHumanJob | undefined> {
  await mkdir(jobOutputDir(job.id), { recursive: true });
  const dest = jobOutputPath(job.id);
  await heygem.downloadResult(job.provider_job_id!, dest);
  const rate = getConfig().heygem?.gpuHourlyRateYuan ?? 0;
  const actualCost = processingSeconds !== null
    ? Math.round(((processingSeconds * rate) / 3600) * 10000) / 10000
    : job.estimated_cost;
  const updated = jobsRepo.updateJob(job.id, {
    status: "done",
    progress: 100,
    result_url: `/api/digital-humans/jobs/${encodeURIComponent(job.id)}/output`,
    result_local_path: dest,
    actual_cost: actualCost,
  });
  recordActivity();
  return updated;
}

export async function deleteJob(jobId: string): Promise<boolean> {
  // 先校验 ID 格式再查库，确认记录存在后才删文件，杜绝 ../ 路径逃逸删除 dataDir 之外的目录
  if (!isValidJobId(jobId)) return false;
  const job = jobsRepo.getJob(jobId);
  if (!job) return false;
  await rm(jobOutputDir(job.id), { recursive: true, force: true });
  return jobsRepo.deleteJob(job.id);
}

export async function regenerateJob(jobId: string): Promise<DbDigitalHumanJob> {
  const job = jobsRepo.getJob(jobId);
  if (!job) throw new Error("Job not found");
  return submitJob({
    workId: job.work_id,
    avatarId: job.avatar_id,
    audioUrl: job.audio_path,
    scriptId: job.script_id,
    estimatedCost: job.estimated_cost,
  });
}

export async function pollJob(jobId: string, intervalMs = 5000, timeoutMs = 600_000): Promise<DbDigitalHumanJob | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await refreshJob(jobId);
    if (job?.status === "done" || job?.status === "failed") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return jobsRepo.updateJob(jobId, { status: "failed", error: "Polling timeout" });
}
