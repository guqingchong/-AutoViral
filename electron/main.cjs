"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { existsSync } = require("node:fs");

const IS_PACKAGED = app.isPackaged;
// 2026-09-12 修复:electron-builder 把文件打进 resources/app.asar 归档,
// 不存在 resources/app 目录——原代码只认后者,导致打包后找不到服务器脚本直接退出。
const APP_ROOT = IS_PACKAGED
  ? (existsSync(join(process.resourcesPath, "app"))
      ? join(process.resourcesPath, "app")
      : join(process.resourcesPath, "app.asar"))
  : process.cwd();
// 2026-09-12 修复:真正的服务器入口是 dist/index.js(CLI:start --foreground)。
// 原来指向 dist/server/index.js——那个文件只导出 startServer() 不执行,
// 子进程加载后静默 exit 0,服务器从未启动。
const SERVER_SCRIPT = join(APP_ROOT, "dist", "index.js");
const SERVER_ARGS = ["start", "--foreground"]; // 不带 --foreground 会 fork 守护进程后立即退出
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
    // 打包后无随包 node.exe,resolveNode() 退化为 electron.exe——
    // ELECTRON_RUN_AS_NODE 让它以纯 Node 模式跑服务器脚本。
    // Electron 版 Node 自带 asar 补丁,可直接读 app.asar 内文件,
    // better-sqlite3 原生模块经 app.asar.unpacked 重定向加载(ABI v125 匹配)。
    // 仅打包模式设置:dev 模式 node_modules 是 Node v141 绑定,不能进 electron 进程。
    ...(IS_PACKAGED ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    AUTOVIRAL_PACKAGED: "1",
    AUTOVIRAL_APP_ROOT: APP_ROOT,
    AUTOVIRAL_FFMPEG_PATH: join(APP_ROOT, "bin", "ffmpeg", "ffmpeg.exe"),
    AUTOVIRAL_FFPROBE_PATH: join(APP_ROOT, "bin", "ffmpeg", "ffprobe.exe"),
  };

  serverProcess = spawn(resolveNode(), [SERVER_SCRIPT, ...SERVER_ARGS], {
    // cwd 必须指向真实目录,不能是 app.asar 归档内部路径
    cwd: IS_PACKAGED ? app.getPath("userData") : APP_ROOT,
    env,
    stdio: "inherit",
    windowsHide: true, // 2026-09-11 弹窗治理:Electron 无控制台,服务器进程不弹 node 黑窗
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

async function waitForServer(url, timeoutMs = 120000) {
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

  // 2026-09-12:服务器冷启动(migrate/reconcile/调度器)可能超过 30 秒,
  // 加载失败时自动重试,而不是把错误页晾给用户
  mainWindow.webContents.on("did-fail-load", () => {
    setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(WEB_URL).catch(() => {});
    }, 2000);
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
