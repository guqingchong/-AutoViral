import cron from "node-cron";
import { loadConfig } from "../config.js";
import { collectTrends } from "./trend-research.js";

let task: cron.ScheduledTask | null = null;

export async function startTrendScheduler(): Promise<void> {
  // 先停旧任务：配置变更（关闭/改频率）后重启调度必须生效
  if (task) { task.stop(); task = null; }
  const config = await loadConfig();
  if (!config.research?.enabled) {
    console.log("[scheduler] Trend research disabled");
    return;
  }
  task = cron.schedule(config.research.schedule, async () => {
    console.log("[scheduler] Running scheduled trend collection");
    try {
      const latest = await loadConfig();
      // 领域沿用用户已保存的 interests（未设置则用上一次调研的领域——同一持久化字段）
      const interests = Array.isArray(latest.interests) ? latest.interests : [];
      await collectTrends(latest.research?.platforms ?? config.research.platforms, interests, null, {
        topN: latest.research?.topN,
      });
    } catch (err) {
      console.error("[scheduler] Trend collection failed:", err);
    }
  });
  console.log(`[scheduler] Trend collection scheduled: ${config.research.schedule}`);
}
