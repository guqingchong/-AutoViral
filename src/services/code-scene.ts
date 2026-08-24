/**
 * 代码渲染场景素材(2026-08-14 代码渲染素材层集成)。
 *
 * agent 为结构图/流程图/逻辑链条镜头调用,经子项目 worker(Revideo)渲染
 * 程序化动画 mp4。本服务负责:参数校验(审美确定性)、串行队列、
 * spawn 渲染、质量门禁、资产登记。
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { probeMedia } from "../video/ffmpeg.js";

// 子项目路径必须按模块位置解析,不能用 process.cwd()——服务可能从任意目录启动
// (如 autocode start 从用户主目录启动,cwd 下没有 packages/,2026-08-14 live e2e 实测踩中)
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "code-scene");
const RENDER_TIMEOUT_MS = 180_000;
const VALID_THEMES = new Set(["finance_dark", "warm_gold", "ink_green", "minimal_light"]);

// 时长上限按模板类型区分(2026-08-24 长口播支持):竖屏镜头模板是 4-8s 素材片段,
// 30s 封顶;keynote-leather 是整片口播,时长跟随数字人源片,600s 封顶
const DURATION_MAX_BY_TEMPLATE: Record<string, number> = { "keynote-leather": 600 };
function durationMaxFor(templateName?: string): number {
  return (templateName && DURATION_MAX_BY_TEMPLATE[templateName]) || 30;
}

// 渲染耗时随时长线性增长(实测约 4-6s 渲染/1s 成片):超时按目标时长 15× 自适应,
// 短片保持 180s 兜底,600s 长片放宽到 2.5h
function renderTimeoutMs(targetDuration: number): number {
  return Math.max(RENDER_TIMEOUT_MS, Math.ceil(targetDuration * 15_000));
}

export interface CodeSceneInput {
  workId: string;
  filename: string;
  template?: { name: string; params: Record<string, unknown> };
  customScene?: string;
  duration?: number;
  size?: { w: number; h: number };
  theme?: string;
}

const TEMPLATE_LIMITS: Record<string, { items?: string; min?: number; max?: number }> = {
  "structure-growth": { items: "branches", min: 2, max: 4 },
  "flow-steps": { items: "steps", min: 2, max: 5 },
  "logic-chain": { items: "chain", min: 2, max: 4 },
  // 2026-08-18 03 方案:模板库扩充
  "big-number": {},                                        // 主参数 value(数字)
  "compare-split": {},                                     // 主参数 left/right
  "timeline": { items: "events", min: 2, max: 5 },
  "pyramid": { items: "levels", min: 2, max: 5 },
  "quote-card": {},                                        // 主参数 quote(替代 title)
  "checklist": { items: "items", min: 2, max: 6 },
  "bar-compare": { items: "bars", min: 2, max: 5 },
  // 2026-08-24:横屏整片数字人口播模板(1920×1080,苹果风×深色皮革),主参数 title(≤18字)
  "keynote-leather": {},
};

/** 纯校验:返回错误列表(空数组=合法) */
export function validateCodeSceneInput(input: CodeSceneInput): string[] {
  const errors: string[] = [];
  if (!input.workId) errors.push("workId 必填");
  if (!input.filename || !/^[\w-]+$/.test(input.filename)) errors.push("filename 必填且仅限字母数字连字符");

  const hasTemplate = !!input.template;
  const hasCustom = !!input.customScene;
  if (hasTemplate === hasCustom) {
    errors.push("template 与 customScene 必须二选一");
  } else if (hasTemplate) {
    const t = input.template!;
    const limit = TEMPLATE_LIMITS[t.name];
    if (!limit) {
      errors.push(`未知场景模板: ${t.name}(可选: ${Object.keys(TEMPLATE_LIMITS).join("/")})`);
    } else {
      const p = t.params ?? {};
      // quote-card 以 quote 为主参数,其余模板以 title 为主参数
      if (t.name === "quote-card") {
        if (typeof p.quote !== "string" || !p.quote.trim()) errors.push("params.quote 必填");
        else if ([...p.quote].length > 60) errors.push(`params.quote ≤60 字(当前 ${[...p.quote].length})`);
      } else {
        const title = p.title;
        if (typeof title !== "string" || !title.trim()) errors.push("params.title 必填");
        else {
          // keynote-leather 横屏标题区更宽,上限放宽到 18 字;竖屏镜头模板仍 12 字
          const titleMax = t.name === "keynote-leather" ? 18 : 12;
          if ([...title].length > titleMax) errors.push(`params.title ≤${titleMax} 字(当前 ${[...title].length})`);
        }
      }
      if (t.name === "keynote-leather") {
        for (const key of ["kicker", "subtitleCn", "subtitleEn", "videoSrc"] as const) {
          if (p[key] !== undefined && typeof p[key] !== "string") errors.push(`params.${key} 须为字符串`);
        }
        if (typeof p.subtitleCn === "string" && [...p.subtitleCn].length > 40) {
          errors.push(`params.subtitleCn ≤40 字(当前 ${[...p.subtitleCn].length})`);
        }
        if (typeof p.subtitleEn === "string" && p.subtitleEn.length > 80) {
          errors.push(`params.subtitleEn ≤80 字符(当前 ${p.subtitleEn.length})`);
        }
        if (p.videoRatio !== undefined && (typeof p.videoRatio !== "number" || p.videoRatio <= 0)) {
          errors.push("params.videoRatio 须为正数(源片宽高比)");
        }
      }
      if (t.name === "structure-growth" && (typeof p.center !== "string" || !p.center.trim())) {
        errors.push("params.center 必填");
      }
      if (t.name === "big-number" && typeof p.value !== "number") {
        errors.push("params.value 必填且为数字");
      }
      if (t.name === "compare-split") {
        for (const side of ["left", "right"] as const) {
          const s = p[side] as { label?: string; points?: unknown[] } | undefined;
          if (!s || typeof s.label !== "string" || !Array.isArray(s.points) || s.points.length < 1 || s.points.length > 4) {
            errors.push(`params.${side}.{label,points[1-4]} 必填`);
          }
        }
      }
      if (limit.items) {
        const items = p[limit.items];
        if (!Array.isArray(items)) errors.push(`params.${limit.items} 必须是数组`);
        else if (items.length < limit.min! || items.length > limit.max!) {
          errors.push(`params.${limit.items} 数量须 ${limit.min}-${limit.max}(当前 ${items.length})`);
        }
      }
    }
  }

  if (input.duration !== undefined) {
    const durMax = durationMaxFor(input.template?.name);
    if (input.duration < 1 || input.duration > durMax) {
      errors.push(`duration 须在 1-${durMax} 秒之间`);
    }
  }
  if (input.theme !== undefined && !VALID_THEMES.has(input.theme)) {
    errors.push(`theme 非法: ${input.theme}(可选: ${[...VALID_THEMES].join("/")})`);
  }
  if (input.size && ((input.size.w ?? 0) < 256 || (input.size.h ?? 0) < 256)) {
    errors.push("size 宽高均须 ≥256");
  }
  return errors;
}

// ── 以下为渲染执行(追加到 Task 6 的文件末尾) ──

export interface CodeSceneResult {
  success: boolean;
  path?: string;
  url?: string;
  duration?: number;
  error?: string;
  code?: "TIMEOUT" | "RENDER_FAILED" | "INVALID_PARAMS";
}

// 串行队列:本地单 Edge 实例渲染,并发无收益且会互相覆盖 custom/current.tsx
let queue: Promise<unknown> = Promise.resolve();

export async function renderCodeScene(input: CodeSceneInput): Promise<CodeSceneResult> {
  const errors = validateCodeSceneInput(input);
  if (errors.length) return { success: false, error: errors.join("; "), code: "INVALID_PARAMS" };
  if (!existsSync(join(WORKER_DIR, "node_modules"))) {
    return { success: false, error: "code-scene 子项目未安装依赖,请先执行: cd packages/code-scene && npm install", code: "RENDER_FAILED" };
  }
  const job = queue.then(() => doRender(input));
  queue = job.catch(() => {});
  return job;
}

async function doRender(input: CodeSceneInput): Promise<CodeSceneResult> {
  let stagedCleanup: (() => Promise<void>) | undefined;
  try {
  const jobId = `cs_${randomUUID().slice(0, 8)}`;
  const outDirAbs = join(dataDir, "works", input.workId, "assets", "clips", "code");
  await mkdir(outDirAbs, { recursive: true });
  const outFile = `${input.filename}.mp4`;

  const isKeynote = input.template?.name === "keynote-leather";
  const targetDuration = Math.min(Math.max(input.duration ?? (isKeynote ? 8 : 6), 1), durationMaxFor(input.template?.name));
  const params: Record<string, unknown> | undefined = input.template
    ? { ...input.template.params, theme: input.theme ?? input.template.params.theme }
    : undefined;
  if (isKeynote && params) {
    // 场景呼吸循环轮数按 params.duration 计算,必须与渲染目标时长一致
    params.duration = targetDuration;
    // 数字人源片中转(2026-08-24):revideo 渲染器只认 vite public 下的 URL 形式
    // src("/xxx.mp4"),本地绝对路径会被当相对 URL → MEDIA_ERR_SRC_NOT_SUPPORTED 挂死。
    // 渲染前复制进 public/staged/,渲染结束(成败)即清理。
    const videoSrc = params.videoSrc;
    if (typeof videoSrc === "string" && videoSrc && !videoSrc.startsWith("/") && !/^https?:\/\//.test(videoSrc)) {
      const staged = await stageDigitalHumanAsset(jobId, videoSrc);
      if (!staged) {
        return { success: false, error: `数字人源片不存在或不可读: ${videoSrc}`, code: "INVALID_PARAMS" };
      }
      params.videoSrc = staged.url;
      stagedCleanup = staged.cleanup;
      // 源片宽高比自动探测(默认 720/1280 竖屏,非竖屏源片须给真实比例,否则 cover 构图错位)
      if (params.videoRatio === undefined && staged.ratio) params.videoRatio = staged.ratio;
    }
  }

  const spec = {
    jobId,
    scene: input.template ? input.template.name : "custom",
    params,
    customCode: input.customScene,
    duration: targetDuration,
    // keynote-leather 是横屏整片模板,默认 1920×1080;其余模板默认竖屏 1080×1920
    width: input.size?.w ?? (isKeynote ? 1920 : 1080),
    height: input.size?.h ?? (isKeynote ? 1080 : 1920),
    outFile,
    outDir: outDirAbs,
  };
  const specPath = join(outDirAbs, `${jobId}.spec.json`);
  await writeFile(specPath, JSON.stringify(spec), "utf-8");

  const outputPath = join(outDirAbs, outFile);
  try {
    // 渲染前清掉同名旧产物:渲染器对已有 outFile 可能跳过重渲染(实测 18:24 旧 3.8s
    // 产物原地复用),残留旧文件会污染补时判定与"成功但产物陈旧"的假象
    await rm(outputPath, { force: true });
    await runWorker(specPath, renderTimeoutMs(targetDuration));
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), code: err instanceof WorkerTimeout ? "TIMEOUT" : "RENDER_FAILED" };
  } finally {
    // spec 是一次性输入,渲染结束即清理,避免污染用户可见的 assets 目录(工程债 C2,2026-08-17)
    rm(specPath, { force: true }).catch(() => {});
  }
  if (!existsSync(outputPath)) {
    return { success: false, error: "worker 完成但未产出文件", code: "RENDER_FAILED" };
  }

  let info = await probeMedia(outputPath);
  // duration 参数生效化(2026-08-19 根因修复):场景自然时长与 spec.duration 无关,
  // 不足目标时长时 tpad 克隆末帧补齐(详见 decidePadSeconds 注释)
  const pad = decidePadSeconds(info.duration, targetDuration);
  if (pad > 0) {
    await padWithLastFrame(outputPath, pad);
    info = await probeMedia(outputPath);
  }
  // 质量门禁:无声中间段语义(2026-08-14 起 expectAudio 区分)
  try {
    const { runQualityGate } = await import("./quality-gate.js");
    const report = await runQualityGate(outputPath, { expectAudio: false });
    await writeFile(join(outDirAbs, `${input.filename}.quality.json`), JSON.stringify(report, null, 2), "utf-8");
  } catch { /* 门禁失败不阻断 */ }

  // C5 素材沉淀:登记资产库
  try {
    const { createAsset } = await import("../db/assets-repo.js");
    createAsset({
      name: `代码场景 ${input.template?.name ?? "custom"}: ${String(input.template?.params?.title ?? input.filename)}`,
      file_path: outputPath,
      category: "general",
      type: "video",
      tags: [input.template?.name, "程序化动画", "code-scene"].filter((t): t is string => !!t),
      source: "self-generated",
      license: "unknown",
      compliance_status: "passed",
      metadata: { workId: input.workId, assetKind: "code-scene", template: input.template?.name },
      usage_count: 0,
    });
  } catch { /* 登记失败不阻断 */ }

  const rel = `clips/code/${outFile}`;
  return { success: true, path: outputPath, url: `/api/works/${input.workId}/assets/${rel}`, duration: info.duration };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), code: "RENDER_FAILED" };
  } finally {
    if (stagedCleanup) await stagedCleanup();
  }
}

/**
 * 数字人源片中转:把本地文件复制进 code-scene 的 vite public/staged/,
 * 返回渲染可用的 URL 与源片宽高比;cleanup 在渲染结束后删除中转文件。
 * 源片不存在时返回 null(调用方按参数错误处理)。
 */
async function stageDigitalHumanAsset(
  jobId: string,
  videoSrc: string,
): Promise<{ url: string; ratio?: number; cleanup: () => Promise<void> } | null> {
  if (!existsSync(videoSrc)) return null;
  const ext = (videoSrc.match(/\.\w+$/)?.[0] ?? ".mp4").toLowerCase();
  const stagedName = `${jobId}${ext}`;
  const stagedDir = join(WORKER_DIR, "public", "staged");
  const stagedPath = join(stagedDir, stagedName);
  await mkdir(stagedDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(videoSrc, stagedPath);
  let ratio: number | undefined;
  try {
    const info = await probeMedia(stagedPath);
    if (info.width && info.height) ratio = info.width / info.height;
  } catch { /* 探测失败用模板默认比例 */ }
  return {
    url: `/staged/${stagedName}`,
    ratio,
    cleanup: async () => { await rm(stagedPath, { force: true }).catch(() => {}); },
  };
}

class WorkerTimeout extends Error { constructor(ms: number) { super(`渲染超时(${Math.round(ms / 1000)}s)`); } }

/**
 * 末帧定格补时判定(2026-08-19 根因修复):Revideo 场景是生成器,内部动画时间轴
 * 硬编码,自然时长由模板内容决定(flow-steps 3 步=3.8s,quote-card≈2.07s),
 * 与 spec.duration 无关(project range 只是渲染窗口上限,不会拉长场景)——
 * agent 曾报告"duration 参数似乎不生效(总是 2.07s)"。
 * 修复策略:不足目标时长时用 tpad 克隆末帧补齐(入场动画保持干脆,尾部定格正是
 * 旁白讲解所需的停留);超出目标不裁短(裁切会破坏动画完整性);容差 0.1s
 * (曾用 0.25,3.8s 自然时长 vs 4s 目标的 0.2s 差被吞掉,duration 依旧"不生效")。
 */
export function decidePadSeconds(actual: number | undefined, target: number, tolerance = 0.1): number {
  if (!actual || actual <= 0) return 0;
  const gap = target - actual;
  return gap > tolerance ? gap : 0;
}

/** 用 tpad 克隆末帧把无声渲染段延长 pad 秒(原地替换,返回新探测信息) */
export async function padWithLastFrame(outputPath: string, padSeconds: number): Promise<void> {
  const { getFFmpegPath } = await import("../video/ffmpeg.js");
  const ffmpeg = await getFFmpegPath();
  const tmp = outputPath.replace(/\.mp4$/, ".pad.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(ffmpeg, [
    "-i", outputPath,
    "-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-an", "-y", tmp,
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, outputPath);
}

function runWorker(specPath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["worker.mjs", specPath], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new WorkerTimeout(timeoutMs)); }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`渲染失败(exit ${code}): ${stderr.slice(-600)}`));
    });
  });
}
