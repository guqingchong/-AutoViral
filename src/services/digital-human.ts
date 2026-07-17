import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir, loadConfig } from "../config.js";
import { ChanjingClient } from "./chanjing-client.js";
import { BailianClient } from "./bailian-client.js";
import * as avatarsRepo from "../db/avatars-repo.js";
import * as jobsRepo from "../db/digital-human-jobs-repo.js";
import { assertWithinBudget } from "./budget-service.js";
import type { DbAvatar, DbDigitalHumanJob } from "../db/types.js";

const execFileAsync = promisify(execFile);

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function now(): string { return new Date().toISOString(); }

async function resolveMediaUrl(pathOrUrl: string): Promise<string> {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const config = await loadConfig();
  const base = `http://127.0.0.1:${config.port}`;
  if (pathOrUrl.startsWith("/")) return `${base}${pathOrUrl}`;
  return `${base}/${pathOrUrl}`;
}

function avatarDir(id: string): string { return join(dataDir, "avatars", id); }
function avatarMediaPath(id: string, filename: string): string { return join(avatarDir(id), filename); }
function avatarFramePath(id: string): string { return join(avatarDir(id), "frame.jpg"); }
function jobOutputDir(id: string): string { return join(dataDir, "digital-human-jobs", id); }
function jobOutputPath(id: string): string { return join(jobOutputDir(id), "output.mp4"); }

function publicAvatarMediaUrl(avatarId: string, filename: string): string {
  return `/api/digital-humans/avatars/${encodeURIComponent(avatarId)}/media/${encodeURIComponent(filename)}`;
}
function publicAvatarFrameUrl(avatarId: string): string {
  return `/api/digital-humans/avatars/${encodeURIComponent(avatarId)}/frame`;
}

export async function createAvatarFromUpload(name: string, data: Buffer, filename: string): Promise<DbAvatar> {
  const id = generateId("avatar");
  await mkdir(avatarDir(id), { recursive: true });
  const ext = extname(filename).toLowerCase() || ".bin";
  const safeName = `media${ext}`;
  const mediaPath = avatarMediaPath(id, safeName);
  await writeFile(mediaPath, data);
  const isVideo = [".mp4", ".mov", ".webm", ".avi"].includes(ext);
  const previewUrl = await resolveMediaUrl(publicAvatarMediaUrl(id, safeName));
  const avatar: DbAvatar = {
    id, name,
    status: isVideo ? "training" : "ready",
    source: isVideo ? "chanjing" : "bailian",
    reference_video_path: mediaPath,
    preview_url: previewUrl,
    config: { originalName: filename, mediaName: safeName },
    created_at: now(),
    updated_at: now(),
  };
  avatarsRepo.createAvatar(avatar);
  if (isVideo) {
    trainAvatarWithChanjing(id).catch((err) => {
      console.error(`[digital-human] avatar training failed ${id}:`, err);
      avatarsRepo.updateAvatar(id, { status: "failed", config: { ...avatar.config, trainingError: (err as Error).message } });
    });
  }
  return avatar;
}

export async function importAvatar(name: string, providerAvatarId: string): Promise<DbAvatar> {
  const avatar: DbAvatar = {
    id: generateId("avatar"), name, status: "ready", source: "chanjing",
    provider_avatar_id: providerAvatarId, config: {}, created_at: now(), updated_at: now(),
  };
  avatarsRepo.createAvatar(avatar);
  return avatar;
}

async function trainAvatarWithChanjing(avatarId: string): Promise<void> {
  const avatar = avatarsRepo.getAvatar(avatarId);
  if (!avatar || !avatar.reference_video_path) throw new Error("Avatar or reference video not found");
  const mediaName = (avatar.config.mediaName as string) ?? "media.mp4";
  const videoUrl = await resolveMediaUrl(publicAvatarMediaUrl(avatarId, mediaName));
  const client = new ChanjingClient();
  const result = await client.createAvatar({ name: avatar.name, videoUrl });
  avatarsRepo.updateAvatar(avatarId, {
    provider_avatar_id: result.avatarId,
    status: result.status === "ready" ? "ready" : "training",
    preview_url: result.previewUrl ?? avatar.preview_url,
  });
}

export async function extractFirstFrame(videoPath: string, outPath: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-ss", "00:00:00.100", "-vframes", "1", outPath], { timeout: 30000 });
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
  fallbackOnFailure?: boolean;
}): Promise<DbDigitalHumanJob> {
  const avatar = avatarsRepo.getAvatar(input.avatarId);
  if (!avatar) throw new Error("Avatar not found");
  assertWithinBudget(input.estimatedCost ?? 0);
  const job: DbDigitalHumanJob = {
    id: generateId("dhjob"),
    work_id: input.workId,
    avatar_id: input.avatarId,
    audio_path: input.audioUrl,
    script_id: input.scriptId,
    provider: "chanjing",
    status: "pending",
    progress: 0,
    estimated_cost: input.estimatedCost ?? 0,
    actual_cost: 0,
    created_at: now(),
    updated_at: now(),
  };
  jobsRepo.createJob(job);
  dispatchJob(job.id, input.fallbackOnFailure ?? true).catch((err) => {
    console.error(`[digital-human] dispatch error ${job.id}:`, err);
    jobsRepo.updateJob(job.id, { status: "failed", error: (err as Error).message });
  });
  return job;
}

async function dispatchJob(jobId: string, allowFallback: boolean): Promise<void> {
  const job = jobsRepo.getJob(jobId);
  if (!job) throw new Error("Job not found");
  const avatar = avatarsRepo.getAvatar(job.avatar_id);
  if (!avatar) throw new Error("Avatar not found");
  jobsRepo.updateJob(jobId, { status: "queued", progress: 10 });
  try {
    if (avatar.source === "chanjing" && avatar.provider_avatar_id) {
      const client = new ChanjingClient();
      const audioUrl = await resolveMediaUrl(job.audio_path);
      const submit = await client.submitVideo(avatar.provider_avatar_id, audioUrl);
      jobsRepo.updateJob(jobId, { provider_job_id: submit.jobId, status: "running", progress: 20 });
      return;
    }
  } catch (err) {
    if (!allowFallback) throw err;
    console.warn(`[digital-human] ChanJing failed for ${jobId}, trying Bailian fallback:`, (err as Error).message);
  }
  await dispatchBailian(job, avatar);
}

async function dispatchBailian(job: DbDigitalHumanJob, avatar: DbAvatar): Promise<void> {
  let imageUrl = avatar.preview_url;
  if (avatar.reference_video_path && [".mp4", ".mov", ".webm", ".avi"].includes(extname(avatar.reference_video_path).toLowerCase())) {
    const framePath = avatarFramePath(avatar.id);
    await extractFirstFrame(avatar.reference_video_path, framePath);
    imageUrl = await resolveMediaUrl(publicAvatarFrameUrl(avatar.id));
  }
  if (!imageUrl) throw new Error("No image source available for Bailian fallback");
  const client = new BailianClient();
  const audioUrl = await resolveMediaUrl(job.audio_path);
  const taskId = await client.submitVideo(imageUrl, audioUrl);
  jobsRepo.updateJob(job.id, { provider: "bailian", provider_job_id: taskId, status: "running", progress: 20 });
}

export async function refreshJob(jobId: string): Promise<DbDigitalHumanJob | undefined> {
  const job = jobsRepo.getJob(jobId);
  if (!job || !job.provider_job_id) return job;
  if (job.status === "done" || job.status === "failed") return job;
  try {
    if (job.provider === "chanjing") {
      const client = new ChanjingClient();
      const result = await client.queryVideo(job.provider_job_id);
      if (result.status === "success") return await finalizeJob(job, result.videoUrl);
      if (result.status === "failed") return jobsRepo.updateJob(jobId, { status: "failed", error: result.error ?? "ChanJing job failed", progress: result.progress });
      return jobsRepo.updateJob(jobId, { status: "running", progress: result.progress });
    } else {
      const client = new BailianClient();
      const result = await client.queryVideo(job.provider_job_id);
      if (result.status === "SUCCEEDED") return await finalizeJob(job, result.videoUrl);
      if (result.status === "FAILED") return jobsRepo.updateJob(jobId, { status: "failed", error: result.error ?? "Bailian job failed", progress: result.progress });
      return jobsRepo.updateJob(jobId, { status: "running", progress: result.progress });
    }
  } catch (err) {
    return jobsRepo.updateJob(jobId, { status: "failed", error: (err as Error).message });
  }
}

async function finalizeJob(job: DbDigitalHumanJob, videoUrl?: string): Promise<DbDigitalHumanJob | undefined> {
  if (!videoUrl) throw new Error("Provider returned success without video URL");
  const dir = jobOutputDir(job.id);
  await mkdir(dir, { recursive: true });
  const dest = jobOutputPath(job.id);
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to download result: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return jobsRepo.updateJob(job.id, {
    status: "done",
    progress: 100,
    result_url: videoUrl,
    result_local_path: dest,
    actual_cost: job.estimated_cost,
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
