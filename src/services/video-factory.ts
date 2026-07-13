import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTemplate } from "../db/templates-repo.js";
import { createRenderJob, updateRenderJob, getRenderJob, listRenderJobs } from "../db/render-jobs-repo.js";
import { updateWork, getWork } from "../work-store.js";
import { renderTimeline } from "../video/renderer.js";
import { applyVariables, validateVariableValues } from "../video/variables.js";
import { dataDir } from "../config.js";
import type { Timeline } from "../video/types.js";
import type { DbTemplate } from "../db/templates-repo.js";
import type { DbRenderJob } from "../db/render-jobs-repo.js";

export interface RenderRequest {
  workId: string;
  templateId: string;
  digitalHumanVideo: string;
  voiceAudio: string;
  subtitlePath?: string;
  bgmPath?: string;
  assets: Record<string, string>; // variable name -> file path
  variables?: Record<string, string | number>;
}

export interface RenderJobInfo {
  jobId: string;
  outputPath: string;
  status: DbRenderJob["status"];
}

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - last >= ms) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn(...args);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      last = Date.now();
      timer = null;
      fn(...args);
    }, ms - (now - last));
  }) as T;
}

export async function startRender(req: RenderRequest): Promise<RenderJobInfo> {
  const template = getTemplate(req.templateId);
  if (!template) throw new Error(`Template not found: ${req.templateId}`);

  const jobId = `job_${randomUUID().replace(/-/g, "")}`;
  const workDir = join(dataDir, "works", req.workId, "output");
  await mkdir(workDir, { recursive: true });
  const outputPath = join(workDir, `${jobId}_final.mp4`);

  createRenderJob({
    id: jobId,
    work_id: req.workId,
    template_id: req.templateId,
    output_path: outputPath,
    status: "pending",
    progress: 0,
  });

  // Run asynchronously; errors are handled inside runRenderLoop
  runRenderLoop(jobId, template, req, outputPath);

  return { jobId, outputPath, status: "pending" };
}

async function runRenderLoop(jobId: string, template: DbTemplate, req: RenderRequest, outputPath: string): Promise<void> {
  updateRenderJob(jobId, { status: "running" });

  try {
    const work = await getWork(req.workId);
    if (work) {
      await updateWork(req.workId, { status: "assembling" });
    }
  } catch (err) {
    console.error("Failed to set work status to assembling:", err);
  }

  const updateProgress = throttle((p: { percent?: number; time?: number }) => {
    updateRenderJob(jobId, {
      progress: p.percent ?? 0,
      current_time: p.time,
    });
  }, 1000);

  let failed = false;
  let errorMessage: string | undefined;

  try {
    const variableValues = validateVariableValues(template.variables, { ...req.assets, ...(req.variables ?? {}) });
    variableValues.host_video = req.digitalHumanVideo;
    variableValues.voice_audio = req.voiceAudio;
    if (req.bgmPath) variableValues.bgm = req.bgmPath;
    if (req.subtitlePath) variableValues.subtitle_ass = req.subtitlePath;

    const tlInput: Record<string, unknown> = {
      canvas: template.canvas,
      layers: template.layers,
      audio: template.audio,
      transitions: template.transitions,
    };
    if (template.subtitles && "source" in template.subtitles) {
      tlInput.subtitles = template.subtitles;
    }
    const timeline = applyVariables(tlInput, variableValues) as unknown as Timeline;

    const result = await renderTimeline(timeline, {
      outputPath,
      onProgress: updateProgress,
    });

    updateRenderJob(jobId, {
      status: "completed",
      progress: 100,
      duration: result.duration,
    });
  } catch (err) {
    failed = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    try {
      updateRenderJob(jobId, { status: "failed", error: errorMessage });
    } catch (dbErr) {
      console.error("Failed to update render job status:", dbErr, "original error:", err);
    }
  } finally {
    // Best-effort cleanup of work status; swallow DB errors to avoid unhandled rejections
    try {
      const work = await getWork(req.workId);
      if (work) {
        await updateWork(req.workId, { status: failed ? "failed" : "reviewing" });
      }
    } catch (workErr) {
      console.error("Failed to update work status after render:", workErr);
    }
  }
}

export function getRenderStatus(jobId: string): DbRenderJob | undefined {
  return getRenderJob(jobId);
}

export function recoverStuckRenderJobs(): number {
  const stuck = listRenderJobs("running").concat(listRenderJobs("pending"));
  let recovered = 0;
  for (const job of stuck) {
    try {
      updateRenderJob(job.id, { status: "failed", error: "Recovered from unexpected shutdown" });
      if (job.work_id) {
        updateWork(job.work_id, { status: "failed" }).catch((err) => {
          console.error(`Failed to update work ${job.work_id} after render recovery:`, err);
        });
      }
      recovered++;
    } catch (err) {
      console.error(`Failed to recover render job ${job.id}:`, err);
    }
  }
  return recovered;
}
