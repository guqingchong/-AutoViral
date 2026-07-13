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
import { apiRoutes, setWsBridge } from "./api.js";
import { analyticsApi } from "./analytics-api.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { commentsRoutes } from "./routes/comments.js";
import { evolutionRoutes } from "./routes/evolution.js";
import { WsBridge } from "../ws-bridge.js";
import { registerAllAdapters } from "./analytics-api.js";
import { startTrendScheduler } from "../services/scheduler.js";
import { startMetricsScheduler } from "../services/analytics-scheduler.js";
import { migrate } from "../db/migrate.js";
import { migrateLegacyWorks } from "../db/migrate-legacy.js";
import { recoverStuckJobs, startPublishCron } from "../services/publish-service.js";
import { recoverStuckRenderJobs } from "../services/video-factory.js";

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

  // 0.7. Start periodic stuck-job sweep (every 5 minutes)
  startPublishCron();

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

  return { server: httpServer };
}
