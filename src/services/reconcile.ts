/**
 * Work state reconciliation（状态对账）。
 *
 * 背景（2026-07-21 Bug2/Bug4 根因）：系统存在三套互不同步的状态机 ——
 * works.status、pipeline_steps.status、render_jobs.status。一旦某条写入路径
 * 遗漏（如渲染完成未回写、打回后无出口），作品状态就永久卡死。
 *
 * 本模块在服务器启动时与定期运行，做两件保守的、只向前的修复：
 * 1. 组装完成判定：works.status = assembling，但 render_jobs 已有 completed
 *    记录或 output/ 下已存在成片（*final*.mp4）→ 转正为 reviewing，
 *    并把 assembly 步骤置为 done。
 * 2. 派生状态前进：由 pipeline_steps 推导出的状态若"领先于" works.status
 *    （如步骤已全 done 而 status 还停在 planning）→ 向前对齐，绝不回退。
 *
 * 不做的事（刻意保守）：
 * - 不把任何作品置为 failed（无法区分"真失败"与"会话暂时中断"）；
 * - 不回退 published / failed 终态；
 * - 不触碰有 running/pending render_job 的作品（渲染正在进行中）。
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { listWorks as dbListWorks, getWorkSteps } from "../db/works-repo.js";
import { listRenderJobs } from "../db/render-jobs-repo.js";
import {
  deriveStatusFromPipeline,
  statusOrder,
  updateWork,
  type PipelineStep,
  type WorkStatus,
} from "../work-store.js";
import type { DbWork } from "../db/types.js";

export interface ReconcileResult {
  checked: number;
  fixed: number;
  details: string[];
}

/** 检查作品 output/ 目录下是否已存在成片（文件名含 final 的视频），返回路径与 mtime */
async function findFinalVideo(workId: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  try {
    const outDir = join(dataDir, "works", workId, "output");
    const entries = await readdir(outDir);
    const name = entries.find((f) => /\.(mp4|mov|webm)$/i.test(f) && /final/i.test(f));
    if (!name) return undefined;
    const full = join(outDir, name);
    const st = await stat(full);
    return { path: full, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

function stepsToPipeline(workId: string): Record<string, PipelineStep> {
  const pipeline: Record<string, PipelineStep> = {};
  for (const s of getWorkSteps(workId)) {
    pipeline[s.step_key] = {
      name: s.name,
      status: s.status,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      note: s.note,
    };
  }
  return pipeline;
}

export async function reconcileWorkStates(trigger: "startup" | "periodic" = "periodic"): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, fixed: 0, details: [] };
  const works = dbListWorks();

  for (const w of works as DbWork[]) {
    // 终态不动
    if (w.status === "published" || w.status === "failed") continue;
    result.checked++;

    const pipeline = stepsToPipeline(w.id);

    // ── 1. 组装完成转正 ─────────────────────────────────────────────
    if (w.status === "assembling") {
      const activeRender = listRenderJobs("running", w.id).length + listRenderJobs("pending", w.id).length;
      if (activeRender === 0) {
        // 关键时序判定：只当"成品产生于本轮 assembly 开始之后"才转正。
        // 否则打回重做（assembly 被重置、started_at 刷新）后，旧成品会导致
        // 打回被对账撤销 —— 2026-07-21 复盘发现。
        const assemblyStartedAt = pipeline["assembly"]?.startedAt
          ? Date.parse(pipeline["assembly"].startedAt)
          : 0;
        const completedJob = listRenderJobs("completed", w.id, 5).find(
          (j) => j.output_path && existsSync(j.output_path) && Date.parse(j.updated_at) >= assemblyStartedAt,
        );
        const finalInDir = await findFinalVideo(w.id);
        const freshFinal = finalInDir && finalInDir.mtimeMs >= assemblyStartedAt ? finalInDir : undefined;
        if (completedJob || freshFinal) {
          if (pipeline["assembly"] && pipeline["assembly"].status !== "done") {
            pipeline["assembly"] = {
              ...pipeline["assembly"],
              status: "done",
              completedAt: pipeline["assembly"].completedAt ?? new Date().toISOString(),
              note: pipeline["assembly"].note ?? "对账修复：成片已存在",
            };
          }
          await updateWork(w.id, { status: "reviewing", pipeline });
          result.fixed++;
          result.details.push(`${w.id} assembling→reviewing（成片已存在: ${completedJob?.output_path ?? freshFinal?.path}）`);
          continue;
        }
      }
    }

    // ── 2. 派生状态只向前对齐 ────────────────────────────────────────
    const derived = deriveStatusFromPipeline(pipeline, w.status as WorkStatus);
    if (statusOrder(derived) > statusOrder(w.status as WorkStatus)) {
      await updateWork(w.id, { status: derived });
      result.fixed++;
      result.details.push(`${w.id} ${w.status}→${derived}（跟随流水线进度）`);
    }
  }

  if (result.fixed > 0 || trigger === "startup") {
    console.log(
      `[reconcile:${trigger}] checked=${result.checked} fixed=${result.fixed}` +
        (result.details.length ? " :: " + result.details.join(" | ") : ""),
    );
  }
  return result;
}
