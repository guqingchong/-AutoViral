import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { getTemplate, incrementTemplateUsage } from "../db/templates-repo.js";
import { createRenderJob, updateRenderJob, getRenderJob, listRenderJobs } from "../db/render-jobs-repo.js";
import { updateWork, getWork } from "../work-store.js";
import { renderTimeline } from "../video/renderer.js";
import { applyVariables, validateVariableValues } from "../video/variables.js";
import { brandingToImageLayer } from "../video/branding.js";
import { dataDir } from "../config.js";
import type { Timeline } from "../video/types.js";
import type { DbTemplate } from "../db/templates-repo.js";
import type { DbRenderJob } from "../db/render-jobs-repo.js";

export interface RenderRequest {
  workId: string;
  templateId: string;
  /** 数字人口播视频:仅当模板声明了 host_video 变量时必填(2026-08-13 变量通用化) */
  digitalHumanVideo?: string;
  /** 配音音频:仅当模板声明了 voice_audio 变量时必填 */
  voiceAudio?: string;
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
  let latestArgs: Parameters<T> | undefined;
  return ((...args: Parameters<T>) => {
    latestArgs = args;
    const now = Date.now();
    if (now - last >= ms) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn(...latestArgs);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      last = Date.now();
      timer = null;
      if (latestArgs) fn(...latestArgs);
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
  // 使用频次 +1：模板自进化的偏好信号（生成时优先参考高频模板风格）
  incrementTemplateUsage(req.templateId);

  // Run asynchronously; errors are handled inside runRenderLoop
  runRenderLoop(jobId, template, req, outputPath);

  return { jobId, outputPath, status: "pending" };
}

async function runRenderLoop(jobId: string, template: DbTemplate, req: RenderRequest, outputPath: string): Promise<void> {
  updateRenderJob(jobId, { status: "running" });

  try {
    const work = await getWork(req.workId);
    // 仅当本渲染产出就是最终成片(final.mp4)时才同步作品状态机。
    // 分段模板渲染(job_*_final.mp4)在素材/合成混排流程中被频繁调用，
    // 若也翻转状态机会把进行中作品误判为 reviewing
    // （2026-08-16 d34/166：agent 素材阶段探测性渲染 → 作品跳 reviewing）。
    if (work && /^final\.(mp4|mov|webm)$/i.test(basename(outputPath))) {
      // 同步两套状态机：works.status 与 pipeline_steps.assembly（此前只写前者，
      // 导致作品卡片状态标签与进度条脱节 —— 2026-07-21 Bug2 根因）
      const pipeline = work.pipeline;
      if (pipeline["assembly"] && pipeline["assembly"].status !== "done") {
        pipeline["assembly"] = { ...pipeline["assembly"], status: "active", startedAt: pipeline["assembly"].startedAt ?? new Date().toISOString() };
      }
      await updateWork(req.workId, { status: "assembling", pipeline });
    }
  } catch (err) {
    console.error("Failed to set work status to assembling:", err);
  }

  let failed = false;
  let errorMessage: string | undefined;
  let renderFinished = false;

  const updateProgress = throttle((p: { percent?: number; time?: number }) => {
    if (renderFinished) return;
    updateRenderJob(jobId, {
      progress: p.percent ?? 0,
      current_time: p.time,
    });
  }, 1000);

  try {
    let renderedDuration: number | undefined;

    if (template.kind === "code") {
      // ── code 模板(2026-08-24):不走时间线组装,整片路由到 Revideo 代码渲染 ──
      renderedDuration = await renderCodeTemplate(jobId, template, req, outputPath);
    } else {
    const variableValues = validateVariableValues(template.variables, { ...req.assets, ...(req.variables ?? {}) });
    // 变量通用化(2026-08-13 模板契约修复):约定变量仅当模板声明时才注入;
    // 声明了但请求未提供 → 可读错误,而非静默注入 undefined 导致渲染出坏片
    const declared = new Set(template.variables.map((v) => v.name));
    const bindOptional = (name: string, value: string | undefined) => {
      if (!declared.has(name)) return;
      if (!value) throw new Error(`缺少变量 ${name}:模板声明了该变量但渲染请求未提供`);
      variableValues[name] = value;
    };
    bindOptional("host_video", req.digitalHumanVideo);
    bindOptional("voice_audio", req.voiceAudio);
    bindOptional("bgm", req.bgmPath);
    bindOptional("subtitle_ass", req.subtitlePath);

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

    // 素材驱动时长(2026-08-13 用户决策:模板取消时长约束):每幕时长=该幕
    // 主素材实际时长,幕内图层保持相对节奏;成片时长=各幕素材时长之和,
    // 完全由脚本规划的素材决定,不再被模板写死。
    const { adaptTimelineToAssets } = await import("./timeline-adapt.js");
    const adaptedTimeline = await adaptTimelineToAssets(timeline);

    // 模板级品牌 logo:转为 image layer 追加(2026-08-13 模板库改造 功能 c)
    // 时长取主内容各层 end 的最大值(logo 只覆盖内容期,不拖长成片)
    if (template.branding?.logoAsset) {
      const contentDuration = Math.max(1, ...adaptedTimeline.layers.map((l) => (l.start ?? 0) + (l.duration ?? 0)));
      adaptedTimeline.layers.push(brandingToImageLayer(template.branding, template.canvas, contentDuration));
    }

    const result = await renderTimeline(adaptedTimeline, {
      outputPath,
      onProgress: updateProgress,
    });
    renderedDuration = result.duration;
    }

    renderFinished = true;
    updateRenderJob(jobId, {
      status: "completed",
      progress: 100,
      duration: renderedDuration,
    });

    // C5 素材沉淀:成片自动登记进资产库,供后续作品复用(2026-08-14)
    try {
      const { createAsset } = await import("../db/assets-repo.js");
      const work = await getWork(req.workId);
      createAsset({
        name: work?.title ?? `成片 ${req.workId}`,
        file_path: outputPath,
        category: "general",
        type: "video",
        tags: [work?.title, work?.contentForm, "成片"].filter((t): t is string => !!t),
        source: "self-generated",
        license: "unknown",
        compliance_status: "pending",
        metadata: { workId: req.workId, duration: renderedDuration, assetKind: "final_video" },
        usage_count: 0,
      });
    } catch { /* 登记失败(如路径重复)不阻断渲染结果 */ }

    // 精品化质量门禁:渲染完成自动体检出片报告(2026-08-14)
    try {
      const { runQualityGate } = await import("./quality-gate.js");
      const report = await runQualityGate(outputPath, {
        subtitlePath: req.subtitlePath,
        expectedWidth: template.canvas?.width,
        expectedHeight: template.canvas?.height,
        // 模板图解段(未传配音/字幕/BGM)按无声中间段处理,不强制音轨(2026-08-14 误报修复);
        // code 模板数字人口播音轨内嵌于 host_video(2026-08-24)
        expectAudio: !!(req.subtitlePath || req.digitalHumanVideo || (req as unknown as Record<string, unknown>).voiceAudio || (req as unknown as Record<string, unknown>).voice_audio || (req as unknown as Record<string, unknown>).bgm),
      });
      await writeFile(join(dirname(outputPath), "quality-report.json"), JSON.stringify(report, null, 2), "utf-8");
      if (!report.passed) {
        console.warn(`[quality-gate] ${req.workId} 未通过:`, report.checks.filter((c) => c.level === "fail").map((c) => c.label).join(","));
      }
    } catch (err) {
      console.error("[quality-gate] 门禁执行失败:", err instanceof Error ? err.message : err);
    }
  } catch (err) {
    failed = true;
    renderFinished = true;
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
      // 同上：仅最终成片渲染才回写 assembly 状态/作品 status；分段渲染不动状态机
      if (work && /^final\.(mp4|mov|webm)$/i.test(basename(outputPath))) {
        // 渲染成功 → 同步 assembly 步骤为 done（进度条与状态标签一致）；
        // 渲染失败 → 步骤保持 active 并在 note 中记录错误，便于排查。
        const pipeline = work.pipeline;
        if (pipeline["assembly"]) {
          if (failed) {
            pipeline["assembly"] = { ...pipeline["assembly"], note: `渲染失败: ${errorMessage ?? "unknown"}` };
          } else {
            pipeline["assembly"] = { ...pipeline["assembly"], status: "done", completedAt: new Date().toISOString() };
          }
        }
        await updateWork(req.workId, { status: failed ? "failed" : "reviewing", pipeline });
      }
    } catch (workErr) {
      console.error("Failed to update work status after render:", workErr);
    }
  }
}

export function getRenderStatus(jobId: string): DbRenderJob | undefined {
  return getRenderJob(jobId);
}

/**
 * code 模板整片渲染(2026-08-24 kind="code" 集成)。
 *
 * 约定:layers[0] 存场景配置 { scene: "keynote-leather", params?: {...} };
 * 参数来源优先级:req.variables(每次渲染覆盖)> layers[0].params(模板默认)> 作品字段。
 * host_video(数字人源片)映射为场景 videoSrc,时长取源片实际时长(封顶 30s,
 * revideo worker 渲染窗口上限);产物复制到 outputPath 保持下游(资产登记/门禁)一致。
 */
async function renderCodeTemplate(
  jobId: string,
  template: DbTemplate,
  req: RenderRequest,
  outputPath: string,
): Promise<number | undefined> {
  const cfg = (template.layers?.[0] ?? {}) as { scene?: string; params?: Record<string, unknown> };
  if (typeof cfg.scene !== "string" || !cfg.scene) {
    throw new Error(`code 模板 ${template.id} 缺少场景配置(layers[0].scene)`);
  }
  const work = await getWork(req.workId);

  // 白名单覆盖:agent 可通过 variables 逐作品定制文案
  const OVERRIDABLE = ["title", "kicker", "subtitleCn", "subtitleEn"] as const;
  const overrides: Record<string, unknown> = {};
  for (const key of OVERRIDABLE) {
    const v = req.variables?.[key];
    if (typeof v === "string" && v.trim()) overrides[key] = v;
  }

  const params: Record<string, unknown> = {
    title: (work?.title ?? "未命名作品").slice(0, 18),
    ...cfg.params,
    ...overrides,
  };
  if (req.digitalHumanVideo) params.videoSrc = req.digitalHumanVideo;

  // 时长跟数字人源片走(口播内容长度决定整片时长);占位预览用模板默认
  let duration: number | undefined;
  if (req.digitalHumanVideo) {
    const { probeMedia } = await import("../video/ffmpeg.js");
    const info = await probeMedia(req.digitalHumanVideo);
    if (info.duration && info.duration > 0) duration = Math.min(Math.ceil(info.duration), 30);
  }

  const { renderCodeScene } = await import("./code-scene.js");
  const r = await renderCodeScene({
    workId: req.workId,
    filename: `${jobId}_code`,
    template: { name: cfg.scene, params },
    duration,
    size: template.canvas ? { w: template.canvas.width, h: template.canvas.height } : undefined,
  });
  if (!r.success || !r.path) throw new Error(r.error ?? "code 模板渲染失败");

  // code-scene 产物在 assets/clips/code/ 下,复制到 render_job 约定的输出位置
  const { copyFile } = await import("node:fs/promises");
  await copyFile(r.path, outputPath);
  return r.duration;
}

export function recoverStuckRenderJobs(): number {
  const stuck = listRenderJobs("running").concat(listRenderJobs("pending"));
  let recovered = 0;
  for (const job of stuck) {
    try {
      updateRenderJob(job.id, { status: "failed", error: "Recovered from unexpected shutdown" });
      // 仅当僵死任务是最终成片渲染时才连坐作品为 failed；
      // 分段渲染(job_*_final.mp4)中断由 agent 重试即可，
      // 不能把整个作品标死（2026-08-16 166 被误标 failed 事故）
      const isFinal = !!job.output_path && /^final\.(mp4|mov|webm)$/i.test(basename(job.output_path));
      if (job.work_id && isFinal) {
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
