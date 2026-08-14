/**
 * 代码渲染场景素材(2026-08-14 代码渲染素材层集成)。
 *
 * agent 为结构图/流程图/逻辑链条镜头调用,经子项目 worker(Revideo)渲染
 * 程序化动画 mp4。本服务负责:参数校验(审美确定性)、串行队列、
 * spawn 渲染、质量门禁、资产登记。
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
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

export interface CodeSceneInput {
  workId: string;
  filename: string;
  template?: { name: string; params: Record<string, unknown> };
  customScene?: string;
  duration?: number;
  size?: { w: number; h: number };
  theme?: string;
}

const TEMPLATE_LIMITS: Record<string, { items: string; min: number; max: number }> = {
  "structure-growth": { items: "branches", min: 2, max: 4 },
  "flow-steps": { items: "steps", min: 2, max: 5 },
  "logic-chain": { items: "chain", min: 2, max: 4 },
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
      const title = p.title;
      if (typeof title !== "string" || !title.trim()) errors.push("params.title 必填");
      else if ([...title].length > 12) errors.push(`params.title ≤12 字(当前 ${[...title].length})`);
      if (t.name === "structure-growth" && (typeof p.center !== "string" || !p.center.trim())) {
        errors.push("params.center 必填");
      }
      const items = p[limit.items];
      if (!Array.isArray(items)) errors.push(`params.${limit.items} 必须是数组`);
      else if (items.length < limit.min || items.length > limit.max) {
        errors.push(`params.${limit.items} 数量须 ${limit.min}-${limit.max}(当前 ${items.length})`);
      }
    }
  }

  if (input.duration !== undefined && (input.duration < 1 || input.duration > 30)) {
    errors.push("duration 须在 1-30 秒之间");
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
  try {
  const jobId = `cs_${randomUUID().slice(0, 8)}`;
  const outDirAbs = join(dataDir, "works", input.workId, "assets", "clips", "code");
  await mkdir(outDirAbs, { recursive: true });
  const outFile = `${input.filename}.mp4`;

  const spec = {
    jobId,
    scene: input.template ? input.template.name : "custom",
    params: input.template ? { ...input.template.params, theme: input.theme ?? input.template.params.theme } : undefined,
    customCode: input.customScene,
    duration: input.duration ?? 6,
    width: input.size?.w ?? 1080,
    height: input.size?.h ?? 1920,
    outFile,
    outDir: outDirAbs,
  };
  const specPath = join(outDirAbs, `${jobId}.spec.json`);
  await writeFile(specPath, JSON.stringify(spec), "utf-8");

  const outputPath = join(outDirAbs, outFile);
  try {
    await runWorker(specPath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), code: err instanceof WorkerTimeout ? "TIMEOUT" : "RENDER_FAILED" };
  }
  if (!existsSync(outputPath)) {
    return { success: false, error: "worker 完成但未产出文件", code: "RENDER_FAILED" };
  }

  const info = await probeMedia(outputPath);
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
  }
}

class WorkerTimeout extends Error { constructor() { super("渲染超时(180s)"); } }

function runWorker(specPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["worker.mjs", specPath], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new WorkerTimeout()); }, RENDER_TIMEOUT_MS);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`渲染失败(exit ${code}): ${stderr.slice(-600)}`));
    });
  });
}
