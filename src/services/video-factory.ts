import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTemplate } from "../db/templates-repo.js";
import { createRenderJob, updateRenderJob, getRenderJob } from "../db/render-jobs-repo.js";
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

export async function startRender(req: RenderRequest): Promise<RenderJobInfo> {
  const template = getTemplate(req.templateId);
  if (!template) throw new Error(`Template not found: ${req.templateId}`);

  const jobId = `job_${randomUUID().replace(/-/g, "")}`;
  const workDir = join(dataDir, "works", req.workId, "output");
  await mkdir(workDir, { recursive: true });
  const outputPath = join(workDir, `${jobId}_final.mp4`);

  const job = createRenderJob({
    id: jobId,
    work_id: req.workId,
    template_id: req.templateId,
    output_path: outputPath,
    status: "pending",
    progress: 0,
  });

  const work = await getWork(req.workId);
  if (work) {
    await updateWork(req.workId, { status: "assembling" });
  }

  // Run asynchronously
  runRenderLoop(jobId, template, req, outputPath).catch((err) => {
    try {
      updateRenderJob(jobId, { status: "failed", error: err.message });
    } catch (dbErr) {
      console.error("Failed to update render job status:", dbErr, "original error:", err);
    }
  });

  return { jobId, outputPath, status: "pending" };
}

async function runRenderLoop(jobId: string, template: DbTemplate, req: RenderRequest, outputPath: string): Promise<void> {
  updateRenderJob(jobId, { status: "running" });

  const variableValues = validateVariableValues(template.variables, { ...req.assets, ...(req.variables ?? {}) });
  variableValues.host_video = req.digitalHumanVideo;
  variableValues.voice_audio = req.voiceAudio;
  if (req.bgmPath) variableValues.bgm = req.bgmPath;
  if (req.subtitlePath) variableValues.subtitle_ass = req.subtitlePath;

  // Only pass subtitles when template.subtitles actually has a source property
  // DbTemplate.subtitles defaults to {} from the database, which would fail validateTimeline
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

  try {
    const result = await renderTimeline(timeline, {
      outputPath,
      onProgress: (p) => {
        updateRenderJob(jobId, {
          progress: p.percent ?? 0,
          current_time: p.time,
        });
      },
    });

    updateRenderJob(jobId, {
      status: "completed",
      progress: 100,
      duration: result.duration,
    });

    const work = await getWork(req.workId);
    if (work) {
      await updateWork(req.workId, { status: "reviewing" });
    }
  } catch (err) {
    updateRenderJob(jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    const work = await getWork(req.workId);
    if (work) {
      await updateWork(req.workId, { status: "failed" });
    }
  }
}

export function getRenderStatus(jobId: string): DbRenderJob | undefined {
  return getRenderJob(jobId);
}
