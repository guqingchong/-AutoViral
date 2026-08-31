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
import { readdir, readFile, stat } from "node:fs/promises";
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

/** 会话存活检查（由 server/index.ts 注入，wsBridge.isWorkActive）。
 *  规则1 对活跃会话的作品不得转正——agent 还在干活（刚写出 final.mp4、
 *  尚未 advance 触发评审），对账抢先转正会跳过评审门（2026-08-16 f2c 事故） */
let sessionAliveCheck: ((workId: string) => boolean) | null = null;
export function initReconcile(check: (workId: string) => boolean): void {
  sessionAliveCheck = check;
}

/** 检查作品 output/ 目录下是否已存在成片（final*.mp4），返回路径与 mtime。
 *  注意必须以 final 开头：模板/分段渲染产物形如 job_<id>_final.mp4，
 *  用 /final/i 宽松匹配会把分段误判为成片（2026-08-16 d34 被对账提前转正）。 */
async function findFinalVideo(workId: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  try {
    const outDir = join(dataDir, "works", workId, "output");
    const entries = await readdir(outDir);
    const name = entries.find((f) => /\.(mp4|mov|webm)$/i.test(f) && /^final/i.test(f));
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

/** 最近一轮 assembly 评审结论（eval-assembly-N.json 取最大 N）。
 *  返回 "fail" 时对账不得转正——2026-08-18 事故：评审 round 2 fail(国旗素材 critical)
 *  后 agent 返工途中服务崩溃，重启对账仅凭 final.mp4 存在就把作品抬进 reviewing,
 *  未过审版本流入人工待审栏。 */
async function lastAssemblyEvalVerdict(workId: string): Promise<"pass" | "fail" | null> {
  try {
    const workDir = join(dataDir, "works", workId);
    const files = (await readdir(workDir)).filter((f) => /^eval-assembly-\d+\.json$/.test(f));
    if (!files.length) return null;
    const latest = files.sort((a, b) => parseInt(b.match(/\d+/)![0]) - parseInt(a.match(/\d+/)![0]))[0];
    const j = JSON.parse(await readFile(join(workDir, latest), "utf-8"));
    return j.verdict === "pass" ? "pass" : j.verdict === "fail" ? "fail" : null;
  } catch {
    return null;
  }
}

export async function reconcileWorkStates(trigger: "startup" | "periodic" = "periodic"): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, fixed: 0, details: [] };
  const works = dbListWorks();

  for (const w of works as DbWork[]) {
    // 终态不动
    if (w.status === "published" || w.status === "failed") continue;
    result.checked++;

    const pipeline = stepsToPipeline(w.id);

    // ── 0. 孤儿评审重置（仅启动时）────────────────────────────────────
    // 服务重启会杀死进行中的评审 CLI 进程，步骤永久卡在 evaluating；且
    // startWorkSession 找当前步骤时跳过 evaluating，会话恢复会错选后续阶段
    // （2026-08-16 d34：assets 评审被杀 → 恢复会话直接进 assembly → 对账误判转正）。
    // 启动时所有 evaluating 定义上都是孤儿（评审进程随旧服务死亡），回退 active
    // 等待 agent 重新推进、评审重跑。
    if (trigger === "startup") {
      let touched = false;
      for (const s of Object.values(pipeline)) {
        if ((s.status as string) === "evaluating") { s.status = "active"; touched = true; }
      }
      if (touched) {
        await updateWork(w.id, { pipeline, status: deriveStatusFromPipeline(pipeline, w.status as WorkStatus) });
        result.fixed++;
        result.details.push(`${w.id} 孤儿评审重置 evaluating→active`);
      }
    }

    // ── 1. 组装完成转正 ─────────────────────────────────────────────
    // 活跃会话的作品跳过：agent 会自己 advance（触发评审），对账不抢跑
    if (w.status === "assembling" && !sessionAliveCheck?.(w.id)) {
      // 评审 fail 未翻案时不转正：评审流拥有最终决定权,对账只收拾"无评审参与"的遗留
      const lastVerdict = await lastAssemblyEvalVerdict(w.id);
      if (lastVerdict === "fail") {
        result.details.push(`${w.id} 跳过转正(最近 assembly 评审 fail,待返工/重审)`);
        continue;
      }
      // 2026-08-31 实测实证(a4d):评审开启但 assembly 从未产出 pass verdict
      // (评审自身出错,如 LLM 400)+ 服务重启 → 对账转正绕过终审直接 reviewing。
      // 评审流没跑完 ≠ 无评审参与——留 active,会话恢复后 agent 重新 advance 触发重审。
      if (w.evaluation_mode && lastVerdict !== "pass") {
        result.details.push(`${w.id} 跳过转正(评审开启且 assembly 无 pass 记录,留待重新送审)`);
        continue;
      }
      const activeRender = listRenderJobs("running", w.id).length + listRenderJobs("pending", w.id).length;
      if (activeRender === 0) {
        // 关键时序判定：只当"成品产生于本轮 assembly 开始之后"才转正。
        // 否则打回重做（assembly 被重置、started_at 刷新）后，旧成品会导致
        // 打回被对账撤销 —— 2026-07-21 复盘发现。
        const assemblyStartedAt = pipeline["assembly"]?.startedAt
          ? Date.parse(pipeline["assembly"].startedAt)
          : 0;
        const completedJob = listRenderJobs("completed", w.id, 5).find(
          (j) => j.output_path && existsSync(j.output_path)
            && /^final/i.test(j.output_path.split(/[\\/]/).pop() ?? "")
            && Date.parse(j.updated_at) >= assemblyStartedAt,
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
