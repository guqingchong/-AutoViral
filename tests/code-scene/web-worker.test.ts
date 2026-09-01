import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 集成测试:真实跑 web-worker 渲 1s mock 页。无 Edge 时跳过。
const edgeExists = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].some(existsSync);

describe.skipIf(!edgeExists)("web-worker 确定性截帧", () => {
  it("1s mock 页渲出 30 帧并合成 mp4", { timeout: 120_000 }, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "web-worker-"));
    const spec = {
      jobId: "test01",
      templatePath: join(process.cwd(), "packages/code-scene/templates-web/_test-mock.html"),
      params: { title: "参数注入验证" },
      theme: "finance_dark",
      duration: 1, width: 1080, height: 1920,
      outFile: "mock.mp4", outDir,
      ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    };
    const specPath = join(outDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const r = spawnSync("node", ["packages/code-scene/web-worker.mjs", specPath], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(outDir, "mock.mp4"))).toBe(true);
  });

  it("big-number web 模板真渲染出片", { timeout: 180_000 }, async () => {
    const { renderCodeScene } = await import("../../src/services/code-scene.js");
    const r = await renderCodeScene({
      workId: "w_web_bignumber_test", filename: "bignumber-web",
      template: { name: "big-number", params: { title: "新能源装机投资", kicker: "行业数据", value: 5.4, format: "wan", caption: "同比增长 38%,首次超越火电", source: "国家能源局" } },
      theme: "finance_dark", duration: 6,
    } as any);
    expect(r.success, r.error).toBe(true);
    expect(r.duration).toBeGreaterThanOrEqual(5.9);
  });

  it("big-number 短镜头 duration=3 走短分支出片", { timeout: 120_000 }, async () => {
    // 回归:web 支路须把 targetDuration 注入 __PARAMS__.duration,
    // 否则模板永远走默认 6s 长分支(2026-09-01 修复 code-scene.ts:227)
    const { renderCodeScene } = await import("../../src/services/code-scene.js");
    const r = await renderCodeScene({
      workId: "w_web_bignumber_test", filename: "bignumber-web-short",
      template: { name: "big-number", params: { title: "社融增量", kicker: "金融数据", value: 38.5, format: "percent", caption: "增速回升", source: "中国人民银行" } },
      theme: "finance_dark", duration: 3,
    } as any);
    expect(r.success, r.error).toBe(true);
    expect(r.duration).toBeGreaterThanOrEqual(2.9);
    expect(r.duration).toBeLessThanOrEqual(3.2);
  });

  it("warm_gold 主题注入生效(__THEME_CSS__ 到达页面)", { timeout: 120_000 }, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "web-worker-theme-"));
    const spec = {
      jobId: "theme01",
      templatePath: join(process.cwd(), "packages/code-scene/templates-web/_test-mock.html"),
      params: { title: "主题验证" },
      theme: "warm_gold",
      duration: 1, width: 1080, height: 1920,
      outFile: "theme.mp4", outDir,
      ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    };
    const specPath = join(outDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const r = spawnSync("node", ["packages/code-scene/web-worker.mjs", specPath], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    // 取末帧附近(动画 ease-out 在 0.9s 已基本停稳),裁 #box 中心 1x1 像素读 RGB:
    // -ss 0.9 快进(1s 短视频 -sseof 找不到可解码帧);format=rgb24 先于 crop
    // (yuv420p 下 1x1 奇数尺寸非法);crop=1:1:540:960 → 盒中心(200x200 居中于 440-640 / 860-1060)
    const ff = process.env.FFMPEG_PATH ?? "ffmpeg";
    const px = spawnSync(ff, [
      "-ss", "0.9", "-i", join(outDir, "theme.mp4"),
      "-frames:v", "1", "-vf", "format=rgb24,crop=1:1:540:960",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-y", join(outDir, "px.rgb"),
    ], { encoding: "utf-8" });
    expect(px.status, px.stderr).toBe(0);
    const rgb = readFileSync(join(outDir, "px.rgb"));
    // warm_gold --accent = #d4af37 = rgb(212,175,55);容差 ±24(编码压缩)
    expect(Math.abs(rgb[0] - 212)).toBeLessThan(24);
    expect(Math.abs(rgb[1] - 175)).toBeLessThan(24);
    expect(Math.abs(rgb[2] - 55)).toBeLessThan(24);
  });
});
