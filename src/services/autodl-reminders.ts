/**
 * AutoDL 开机提醒聚合 + 语音守望(2026-09-18,实测根因修复)。
 *
 * 历史病根:作品页横幅(/api/autodl/reminders)一直是只读聚合,从未接线语音;
 * 唯一的开机语音挂在 POST /api/generate/video 的 eco 分支——要"实际发起生成且
 * eco 档且实例离线"才触发。横幅的设计意图是"提前催开机"(临近素材阶段),
 * 而那时流水线还没发起生成,语音自然从未响过(用户实测确认"从未成功")。
 *
 * 修复:聚合逻辑从端点提取为本模块(端点与守望共用同一份事实),
 * startAutodlReminderWatch 每 60s 扫一次,离线且临近需要时语音播报。
 * 重复提醒节奏交给 voiceNotify 的 3 分钟防抖窗口(窗口过后会再播),
 * 用户一直不开机就会一直被提醒——正是本次实测诉求。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import * as worksRepo from "../db/works-repo.js";
import * as workQueueRepo from "../db/work-queue-repo.js";
import * as dhJobsRepo from "../db/digital-human-jobs-repo.js";
import { getInstanceView } from "./instance-service.js";
import { getH3InstanceView } from "./h3-instance-service.js";
import { voiceNotify } from "./voice-notify.js";

export interface AutodlNeedItem { id: string; title: string; certainty?: "confirmed" | "possible" }
export interface AutodlInstanceReminders {
  state: string;
  consoleUrl: string;
  neededBy: AutodlNeedItem[];
  upcoming: AutodlNeedItem[];
}
export interface AutodlReminders { h3: AutodlInstanceReminders; heygem: AutodlInstanceReminders }

/**
 * 作品页 AutoDL 开机提醒聚合(2026-08-14 起,逻辑从 GET /api/autodl/reminders 原样提取)。
 * 在素材准备阶段开始前提醒开机:
 *   数字人渲染(HeyGem 实例): 作品绑定了 digitalHumanId 且尚无 done 任务
 *   H3 视频生成: 分镜已产出 → 扫描 storyboard.md 的素材路由精确判断(confirmed);
 *               分镜未产出 → assetSource∈{ai,auto,smart} 预估(possible)
 */
export async function computeAutodlReminders(): Promise<AutodlReminders> {
  const h3NeededBy: AutodlNeedItem[] = [];
  const h3Upcoming: AutodlNeedItem[] = [];
  const heygemNeededBy: AutodlNeedItem[] = [];
  const heygemUpcoming: AutodlNeedItem[] = [];
  try {
    const works = worksRepo.listWorks();
    // 时机门(2026-08-16):只有临近素材阶段的进行中作品才催开机。
    // 此前把排队中/分镜未产出的作品也列为 possible,用户看到横幅就提前开机,
    // 但串行 runner 下后面的作品几小时后才到素材阶段——GPU 空烧。
    const runningIds = new Set(
      workQueueRepo.listQueue().filter((i) => i.status === "running").map((i) => i.workId),
    );
    for (const w of works) {
      if (w.type !== "short-video") continue;
      if (w.status === "published" || w.status === "draft") continue;
      // 素材阶段已完成的作品无需提醒
      const steps = worksRepo.getWorkSteps(w.id);
      const assetsStep = steps.find((s) => s.step_key === "assets");
      if (assetsStep && assetsStep.status === "done") continue;
      const planStep = steps.find((s) => s.step_key === "plan");
      // 临近素材 = 素材阶段进行中,或分镜已完成且作品正在 runner 上执行
      const nearAssets = assetsStep?.status === "active"
        || (planStep?.status === "done" && runningIds.has(w.id));

      if (w.digital_human_id) {
        const done = dhJobsRepo.listJobs(w.id).some((j) => j.status === "done");
        if (!done) (nearAssets ? heygemNeededBy : heygemUpcoming).push({ id: w.id, title: w.title });
      }

      const sbPath = join(dataDir, "works", w.id, "plan", "storyboard.md");
      if (existsSync(sbPath)) {
        try {
          const sb = readFileSync(sbPath, "utf-8");
          if (/ai_video|i2v|local-h3|H3|AI\s*生(成)?视频/i.test(sb)) {
            // 分镜已确认需要 H3:临近素材阶段才催开机,否则列入 upcoming 预告
            (nearAssets ? h3NeededBy : h3Upcoming).push({ id: w.id, title: w.title, certainty: "confirmed" });
          }
        } catch { /* 读取失败按无需求处理 */ }
      } else if (nearAssets && w.asset_source && ["ai", "auto", "smart"].includes(w.asset_source)) {
        // 分镜未产出但临近素材:按素材来源预估(possible)
        h3NeededBy.push({ id: w.id, title: w.title, certainty: "possible" });
      }
    }
  } catch (err) {
    console.error("[autodl-reminders] scan failed:", err);
  }
  const [h3, heygem] = await Promise.all([getH3InstanceView(), getInstanceView()]);
  return {
    h3: { state: h3.state, consoleUrl: h3.consoleUrl, neededBy: h3NeededBy, upcoming: h3Upcoming },
    heygem: { state: heygem.state, consoleUrl: heygem.consoleUrl, neededBy: heygemNeededBy, upcoming: heygemUpcoming },
  };
}

export interface BootAlert { key: string; text: string }

/**
 * 开机语音提醒决策(纯函数):
 * 只对「实例离线 && neededBy 非空(临近素材阶段)」出提醒;
 * upcoming 预告不提醒(时机门纪律同上,避免提前开机空烧 GPU)。
 * key 含实例种类 + 作品 id 列表——新作品出现立即重播,稳定期靠 voiceNotify
 * 的 3 分钟防抖窗口自然形成"每 3 分钟再催一次"的节奏。
 */
export function collectBootAlerts(r: AutodlReminders): BootAlert[] {
  const alerts: BootAlert[] = [];
  const kinds: Array<{ kind: "h3" | "heygem"; label: string }> = [
    { kind: "h3", label: "H3 视频生成" },
    { kind: "heygem", label: "数字人渲染" },
  ];
  for (const { kind, label } of kinds) {
    const inst = r[kind];
    if (inst.state === "ready" || inst.neededBy.length === 0) continue;
    const titles = inst.neededBy.map((w) => `《${w.title}》`).join("、");
    const ids = inst.neededBy.map((w) => w.id).sort().join(",");
    alerts.push({
      key: `autodl-boot:${kind}:${ids}`,
      text: `请开机 AutoDL 实例:${titles} 即将进入素材阶段,${label}需要实例在线。开机后流水线会自动继续`,
    });
  }
  return alerts;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** 启动 AutoDL 开机提醒语音守望(默认每 60s 一扫;幂等,重复调用先停旧循环)。 */
export function startAutodlReminderWatch(intervalMs = 60_000): ReturnType<typeof setInterval> {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    // fire-and-forget:聚合失败只记日志,绝不阻塞/搞挂守望循环
    computeAutodlReminders()
      .then((r) => {
        for (const alert of collectBootAlerts(r)) voiceNotify(alert.text, alert.key);
      })
      .catch((err) => console.error("[autodl-reminders] watch tick failed:", err));
  }, intervalMs);
  return watchTimer;
}

/** 停止守望(测试/关机用)。 */
export function stopAutodlReminderWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
