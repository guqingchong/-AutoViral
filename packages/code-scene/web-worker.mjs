// web-worker.mjs — kind=web HTML 模板确定性截帧渲染器(2026-09-01 05 方案 S3)
// 用法: node web-worker.mjs <spec.json>
// 确定性:逐帧 document.getAnimations() seek + screenshot,禁止实时录屏。
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.env.LANG = process.env.LANG || "zh_CN.UTF-8";

const specPath = process.argv[2];
if (!specPath) { console.error("usage: node web-worker.mjs <spec.json>"); process.exit(2); }
const spec = JSON.parse(await readFile(specPath, "utf-8"));

const FPS = 30;
const duration = Math.min(Math.max(spec.duration ?? 6, 1), 600);
const W = spec.width ?? 1080, H = spec.height ?? 1920;
const totalFrames = Math.round(duration * FPS);

// design-tokens.css 按主题抽块注入
const tokensPath = join(dirname(fileURLToPath(import.meta.url)), "src", "design-tokens.css");
const tokensCss = await readFile(tokensPath, "utf-8");
const themeKey = spec.theme ?? "finance_dark";
const m = tokensCss.match(new RegExp(`:root\\[data-theme="${themeKey}"\\]\\s*\\{([^}]*)\\}`));
if (!m) { console.error(JSON.stringify({ ok: false, error: `未知主题: ${themeKey}` })); process.exit(1); }
const themeCss = `:root{${m[1]}}`;

const { chromium } = await import("playwright");
const framesDir = join(spec.outDir, `${spec.jobId}_frames`);
await mkdir(framesDir, { recursive: true });
await mkdir(spec.outDir, { recursive: true });

// 参数中的本地绝对路径转 file:/// URL(file:// 页面下裸路径不可加载;网络隔离只放行 file:)
function pathsToFileUrls(v) {
  if (typeof v === "string") {
    if (/^[A-Za-z]:[\\/]/.test(v)) return "file:///" + v.replace(/\\/g, "/");
    if (v.startsWith("/") && existsSync(v)) return "file://" + v;
    return v;
  }
  if (Array.isArray(v)) return v.map(pathsToFileUrls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, pathsToFileUrls(val)]));
  return v;
}

const edgeCandidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = edgeCandidates.find(existsSync);
// --enable-unsafe-swiftshader:L5 WebGL 模板兜底——无 GPU/被禁用时回落软件渲染,
// 截帧仍确定(u_time 驱动,与 GPU 无光栅差异敏感性);对纯 DOM 模板无副作用
const launchArgs = ["--enable-unsafe-swiftshader"];
const browser = await chromium.launch(executablePath ? { executablePath, args: launchArgs } : { channel: "msedge", args: launchArgs });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // 网络隔离(2026-09-01 终审 C1):customHtml 是 LLM 自写代码,渲染页若可出网,
  // 恶意/被注入的脚本可在渲染窗口期以服务器身份反调本机无鉴权 API(localhost:3271)。
  // 只允许 file:/data:/blob:(自包含模板与内联资源),其余一律 abort;非 file 导航即终止。
  await page.route("**/*", (r) => {
    const url = r.request().url();
    return /^(file|data|blob):/.test(url) ? r.continue() : r.abort();
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && !frame.url().startsWith("file://")) {
      console.error(JSON.stringify({ ok: false, error: `非法导航已被拦截: ${frame.url()}` }));
      process.exit(1);
    }
  });
  // 参数与主题先于页面脚本注入(addInitScript 仅支持单参数,故打包为对象)
  await page.addInitScript((injected) => {
    window.__PARAMS__ = injected.params;
    window.__THEME_CSS__ = injected.css;
  }, { params: pathsToFileUrls(spec.params ?? {}), css: themeCss });
  await page.goto("file:///" + spec.templatePath.replaceAll("\\", "/"));
  await page.evaluate(() => document.fonts.ready);

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f / FPS) * 1000;
    await page.evaluate((t) => {
      document.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
      window.__seek?.(t / 1000);
    }, tMs);
    // 模板内嵌 <video>(如数字人窗口)按帧同步:seek 到同一时刻并等 seeked,
    // 否则截帧拿到的是未解码帧(黑/首帧)
    await page.evaluate(async (t) => {
      const videos = [...document.querySelectorAll("video")];
      await Promise.all(videos.map((v) => new Promise((res) => {
        const target = Math.min(t / 1000, (v.duration || 0) - 0.05);
        if (!Number.isFinite(target) || target < 0) return res(null);
        const onSeeked = () => { v.removeEventListener("seeked", onSeeked); res(null); };
        v.addEventListener("seeked", onSeeked);
        v.currentTime = target;
        setTimeout(() => { v.removeEventListener("seeked", onSeeked); res(null); }, 1500);
      })));
    }, tMs);
    // 2026-09-03 性能实测:PNG 截帧 2.5s/帧(1080×1920 SwiftShader),300 帧超 180s
    // 超时线。JPEG q92 截帧快 ~40%(中间帧随即走 libx264,质量损失不可见)
    await page.screenshot({ path: join(framesDir, `f${String(f).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92 });
  }
} finally {
  await browser.close();
}

// 图片序列 → mp4
// X12 验收修复(2026-09-07,R1 全链路):此前硬编码 libx264——code-scene 逐帧合成是
// 渲染量最大的路径,QSV 在此空转。内联同款最小探测(独立进程无法 import src/encoder.ts):
// AUTOVIRAL_ENCODER=qsv|cpu 强制覆盖;auto 时列表+1 秒黑场试编码双段验证。
// 失败回退:QSV 编码失败(核显被占/驱动异常)自动重试 libx264,绝不让硬件加速变成失败源。
const ff = spec.ffmpegPath ?? "ffmpeg";
const out = join(spec.outDir, spec.outFile);

const QSV_ARGS = ["-c:v", "h264_qsv", "-global_quality", "22", "-look_ahead", "1", "-qsv_brc", "ICQ",
  "-preset", "medium", "-g", "60", "-flags", "+cgop", "-pix_fmt", "yuv420p"];
const CPU_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];

function detectQsvInline() {
  const mode = (process.env.AUTOVIRAL_ENCODER ?? "auto").trim().toLowerCase();
  if (mode === "cpu") return false;
  if (mode === "qsv") return true;
  const list = spawnSync(ff, ["-hide_banner", "-encoders"], { encoding: "utf-8" });
  if (list.status !== 0 || !/\bh264_qsv\b/.test(list.stdout ?? "")) return false;
  const trial = spawnSync(ff, ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=black:s=256x256:d=1", "-c:v", "h264_qsv", "-f", "null", "-"], { encoding: "utf-8" });
  return trial.status === 0;
}

const framesPattern = join(framesDir, "f%05d.jpg");
const encodersToTry = detectQsvInline() ? [QSV_ARGS, CPU_ARGS] : [CPU_ARGS];
let encOk = false;
let lastErr = "";
for (const encArgs of encodersToTry) {
  const enc = spawnSync(ff, [
    "-framerate", String(FPS), "-i", framesPattern,
    ...encArgs, "-y", out,
  ], { encoding: "utf-8" });
  if (enc.status === 0 && existsSync(out)) { encOk = true; break; }
  lastErr = enc.stderr?.slice(-400) ?? "";
}
await rm(framesDir, { recursive: true, force: true });
if (!encOk) {
  console.error(JSON.stringify({ ok: false, error: `ffmpeg 失败: ${lastErr}` }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, out, duration }));
