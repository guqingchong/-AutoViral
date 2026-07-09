import cron from "node-cron";
import { loadConfig } from "../config.js";
import { collectTrends } from "./trend-research.js";

let task: cron.ScheduledTask | null = null;

export async function startTrendScheduler(): Promise<void> {
  const config = await loadConfig();
  if (!config.research?.enabled) {
    console.log("[scheduler] Trend research disabled");
    return;
  }
  if (task) task.stop();
  task = cron.schedule(config.research.schedule, async () => {
    console.log("[scheduler] Running scheduled trend collection");
    try {
      await collectTrends(config.research.platforms);
    } catch (err) {
      console.error("[scheduler] Trend collection failed:", err);
    }
  });
  console.log(`[scheduler] Trend collection scheduled: ${config.research.schedule}`);
}
