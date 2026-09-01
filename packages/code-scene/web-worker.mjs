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

const edgeCandidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = edgeCandidates.find(existsSync);
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // 参数与主题先于页面脚本注入(addInitScript 仅支持单参数,故打包为对象)
  await page.addInitScript((injected) => {
    window.__PARAMS__ = injected.params;
    window.__THEME_CSS__ = injected.css;
  }, { params: spec.params ?? {}, css: themeCss });
  await page.goto("file:///" + spec.templatePath.replaceAll("\\", "/"));
  await page.evaluate(() => document.fonts.ready);

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f / FPS) * 1000;
    await page.evaluate((t) => {
      document.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
      window.__seek?.(t / 1000);
    }, tMs);
    await page.screenshot({ path: join(framesDir, `f${String(f).padStart(5, "0")}.png`), type: "png" });
  }
} finally {
  await browser.close();
}

// 图片序列 → mp4(与主仓渲染参数一致:libx264 crf18 yuv420p)
const ff = spec.ffmpegPath ?? "ffmpeg";
const out = join(spec.outDir, spec.outFile);
const enc = spawnSync(ff, [
  "-framerate", String(FPS), "-i", join(framesDir, "f%05d.png"),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-y", out,
], { encoding: "utf-8" });
await rm(framesDir, { recursive: true, force: true });
if (enc.status !== 0 || !existsSync(out)) {
  console.error(JSON.stringify({ ok: false, error: `ffmpeg 失败: ${enc.stderr?.slice(-400)}` }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, out, duration }));
