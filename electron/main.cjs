"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { existsSync } = require("node:fs");

const IS_PACKAGED = app.isPackaged;
const APP_ROOT = IS_PACKAGED ? join(process.resourcesPath, "app") : process.cwd();
const SERVER_SCRIPT = join(APP_ROOT, "dist", "server", "index.js");
const WEB_URL = "http://localhost:3271";

let serverProcess = null;
let mainWindow = null;

function resolveNode() {
  const bundledNode = join(APP_ROOT, "bin", "node.exe");
  if (existsSync(bundledNode)) return bundledNode;
  return process.execPath;
}

function startServer() {
  if (!existsSync(SERVER_SCRIPT)) {
    console.error(`Server script not found: ${SERVER_SCRIPT}`);
    app.quit();
    return;
  }

  const env = {
    ...process.env,
    AUTOVIRAL_PACKAGED: "1",
    AUTOVIRAL_APP_ROOT: APP_ROOT,
    AUTOVIRAL_FFMPEG_PATH: join(APP_ROOT, "bin", "ffmpeg", "ffmpeg.exe"),
    AUTOVIRAL_FFPROBE_PATH: join(APP_ROOT, "bin", "ffmpeg", "ffprobe.exe"),
  };

  serverProcess = spawn(resolveNode(), [SERVER_SCRIPT], {
    cwd: APP_ROOT,
    env,
    stdio: "inherit",
  });

  serverProcess.on("error", (err) => {
    console.error("Server process error:", err);
  });

  serverProcess.on("exit", (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status === 404) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: "AutoViral",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(WEB_URL).catch((err) => {
    console.error("Failed to load dashboard:", err);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startServer();
  const ready = await waitForServer(`${WEB_URL}/api/health`);
  if (!ready) {
    console.error("Server did not become ready in time");
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopServer();
});

ipcMain.on("autoviral-quit", () => {
  app.quit();
});

ipcMain.on("autoviral-reload", () => {
  if (mainWindow) mainWindow.loadURL(WEB_URL);
});

ipcMain.handle("autoviral-version", () => app.getVersion());
