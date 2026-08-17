import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Server } from "node:http";
import { loadConfig, dataDir } from "../config.js";
import { initProviders } from "../providers/registry.js";
import { ensureSharedDirs } from "../shared-assets.js";
import { apiRoutes, setWsBridge, startWorkSession } from "./api.js";
import { initWorkQueue, startRunner, stopRunner } from "../services/work-queue.js";
import { startWatchdog, stopWatchdog } from "../services/work-watchdog.js";
import {
  startRenderPoolScheduler,
  stopRenderPoolScheduler,
  recoverRunningRenderJobs,
} from "../services/digital-human-pipeline.js";
import { analyticsApi } from "./analytics-api.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { commentsRoutes } from "./routes/comments.js";
import { evolutionRoutes } from "./routes/evolution.js";
import { WsBridge } from "../ws-bridge.js";
import { registerAllAdapters } from "./analytics-api.js";
import { startTrendScheduler } from "../services/scheduler.js";
import { startMetricsScheduler } from "../services/analytics-scheduler.js";
import { migrate } from "../db/migrate.js";
import { closeDb } from "../db/connection.js";
import { migrateLegacyWorks } from "../db/migrate-legacy.js";
import { recoverStuckJobs, startPublishCron } from "../services/publish-service.js";
import { recoverStuckRenderJobs } from "../services/video-factory.js";
import { startHealthLoop, stopHealthLoop } from "../services/instance-service.js";
import { startH3HealthLoop, stopH3HealthLoop } from "../services/h3-instance-service.js";
import { reconcileWorkStates, initReconcile } from "../services/reconcile.js";
import { registerAllPublishers } from "../services/publishers/factory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve web/dist relative to the package root (two levels up from dist/server/)
const WEB_DIST = join(__dirname, "..", "..", "web", "dist");

function resolveBundledFfmpeg(): { ffmpeg: string; ffprobe: string } | undefined {
  const appRoot = process.env.AUTOVIRAL_APP_ROOT;
  if (!appRoot) return undefined;
  const ffmpeg = join(appRoot, "bin", "ffmpeg", "ffmpeg.exe");
  const ffprobe = join(appRoot, "bin", "ffmpeg", "ffprobe.exe");
  if (existsSync(ffmpeg) && existsSync(ffprobe)) {
    return { ffmpeg, ffprobe };
  }
  return undefined;
}

function setFfmpegEnv(): void {
  const bundled = resolveBundledFfmpeg();
  if (bundled) {
    process.env.FFMPEG_PATH = bundled.ffmpeg;
    process.env.FFPROBE_PATH = bundled.ffprobe;
    console.log(`Using bundled FFmpeg: ${bundled.ffmpeg}`);
  }
}

// ── Crash protection (BUG-3) ──────────────────────────────────────────────────
// Global error handlers prevent silent process death. uncaughtException still
// exits (process state may be corrupt) but logs the fault so it is diagnosable.
// unhandledRejection only logs — forgotten promises should not kill the server.

function installCrashHandlers(): void {
  const crashLog = join(dataDir, "crash.log");

  async function writeCrashLog(line: string): Promise<void> {
    try {
      await appendFile(crashLog, `${new Date().toISOString()} ${line}\n`, "utf-8");
    } catch {
      // Last-resort: if even crash log fails, write to stderr
      process.stderr.write(`${new Date().toISOString()} ${line}\n`);
    }
  }

  process.on("uncaughtException", (err) => {
    const msg = `[FATAL] uncaughtException: ${err.message}\n${err.stack ?? "(no stack)"}`;
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
    writeCrashLog(msg);
    // Give logs a moment to flush, then exit so a process manager can restart
    setTimeout(() => process.exit(1), 1000);
  });

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ""}`
      : String(reason);
    const msg = `[WARN] unhandledRejection: ${detail}`;
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
    writeCrashLog(msg);
  });
}

export async function startServer(port: number): Promise<{ server: Server }> {
  // 0.0. Install crash protection before anything else
  installCrashHandlers();
  // 0. Ensure database schema
  migrate();

  // 0.5. Recover publish jobs that were stuck "publishing" from a prior crash
  recoverStuckJobs();

  // 0.6. Recover render jobs that were stuck "running" or "pending" from a prior crash
  recoverStuckRenderJobs();

  // 0.6b. Reconcile work states (render_jobs/pipeline_steps → works.status).
  // Fixes works stuck in "assembling" although the final video already exists.
  // 每 1 分钟跑一次(此前 5 分钟):必须显著快于 watchdog 的 10 分钟停滞阈值,
  // 确保"已完成但未上报"先被对账修复,而不是被 watchdog/runner 重跑导致重复渲染。
  await reconcileWorkStates("startup").catch((err) =>
    console.error("[reconcile] startup run failed:", err),
  );
  setInterval(() => {
    reconcileWorkStates("periodic").catch((err) =>
      console.error("[reconcile] periodic run failed:", err),
    );
  }, 60_000);

  // 0.7. Start periodic stuck-job sweep (every 5 minutes)
  startPublishCron();

  // 0.8. Register all platform publishers (PRD Phase 4a/4b)
  registerAllPublishers();

  // 1. Load config
  const config = await loadConfig();

  // 1b. Detect bundled FFmpeg in packaged builds
  setFfmpegEnv();

  // 1a. Import legacy YAML works once
  const migrated = await migrateLegacyWorks();
  if (migrated > 0) console.log(`Migrated ${migrated} legacy works to SQLite`);

  // 2. Initialize providers
  await initProviders(config);

  // 3. Ensure shared asset directories
  await ensureSharedDirs();

  // 3.2. Ensure template asset directory exists
  await mkdir(join(dataDir, "shared-assets", "templates"), { recursive: true });

  // 3.5. Sync skills to ~/.claude/skills/ (agent reads from there)
  if (!process.env.AUTOVIRAL_PACKAGED) {
    const projectSkills = join(process.cwd(), "skills");
    const installedSkills = join(homedir(), ".claude", "skills");
    if (existsSync(projectSkills)) {
      try {
        execSync(`rsync -a --delete "${projectSkills}/" "${installedSkills}/"`, { stdio: "ignore" });
        console.log("Skills synced to ~/.claude/skills/");
      } catch {
        console.warn("Warning: failed to sync skills to ~/.claude/skills/");
      }
    }
  }

  // 4. Create WsBridge
  const wsBridge = new WsBridge(port);
  setWsBridge(wsBridge);

  // 4b. 作品队列：串行 runner + 反停滞看门狗。
  // 必须在 WsBridge 构造之后初始化(isSessionAlive 依赖 wsBridge 会话表)。
  // 存活判定用 isWorkActive(进程存活 OR 最近 120s 有 CLI 活动),而不是只看
  // 内存 cliProcess:-p 单回合模式下进程每回合退出是常态,纯内存判定会把
  // 回合间空窗误判为"假死"而重复 resume、产生孤儿会话(2026-08-06 根因)。
  const isSessionAlive = (id: string) => wsBridge.isWorkActive(id);
  initWorkQueue({ startWork: (id) => startWorkSession(id), isSessionAlive });
  initReconcile(isSessionAlive);
  startRunner();
  startWatchdog({ isSessionAlive });

  // 4c. 数字人渲染池：60s 周期评估攒批触发（超时触发不依赖入池/上线钩子）；
  // 并接管上一进程遗留的 running 渲染任务（重建轮询，恢复 finalize→登记产物链路）。
  startRenderPoolScheduler();
  void recoverRunningRenderJobs().catch((err) =>
    console.error("[render-pool] recover running jobs failed:", err),
  );

  const app = new Hono();

  // 5. Mount Phase 5 analytics / comments / evolution routes (v2 kept first for specificity)
  app.route("/api/analytics/v2", analyticsApi);
  app.route("/api/analytics", analyticsRoutes);
  app.route("/api/comments", commentsRoutes);
  app.route("/api/evolution", evolutionRoutes);

  // 5. Mount legacy API routes
  app.route("/", apiRoutes);

  // 8. Serve static frontend files from web/dist/
  app.use("/*", serveStatic({ root: WEB_DIST }));

  // SPA fallback: serve index.html for any non-API GET request that didn't match a static file
  app.get("*", async (c) => {
    try {
      const indexPath = join(WEB_DIST, "index.html");
      const html = await readFile(indexPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("Dashboard not built. Run: npm run build:frontend", 404);
    }
  });

  // 6. Start HTTP server + WebSocket upgrade handler
  const nodeServer = serve({
    fetch: app.fetch,
    port,
  });

  const httpServer = nodeServer as unknown as Server;

  // Route HTTP upgrade events
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";

    // Try WsBridge first (handles /ws/browser/:workId)
    if (wsBridge.handleUpgrade(req, socket, head)) {
      return;
    }

    // Unknown upgrade — destroy socket
    socket.destroy();
  });

  // 7. Start background services
  await startTrendScheduler();
  await registerAllAdapters();
  startMetricsScheduler(config.analytics);
  // 实例手动控制模式：30 秒健康探测驱动 ready/offline 状态，供前端提醒
  startHealthLoop();
  startH3HealthLoop();

  // 8. Graceful shutdown: drain pending chat saves on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`\n[server] Received ${signal}, draining pending saves...`);
    stopHealthLoop();
    stopH3HealthLoop();
    stopRunner();
    stopWatchdog();
    stopRenderPoolScheduler();
    wsBridge.destroy();
    closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { server: httpServer };
}
