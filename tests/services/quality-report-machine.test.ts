import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQualityGate, assertAssemblyDeliverables, measureAssSubtitles, QUALITY_REPORT_GENERATOR } from "../../src/services/quality-gate.js";

// 2026-09-11(CPS 声明失真复盘):质量报告声明 "CPS≤6.25" 实测 7.08——
// 报告由 agent 手写,关键指标未经机器核验。修复:字幕项机器实测 + generator 标记门禁。
describe("measureAssSubtitles 字幕机器实测", () => {
  it("实测最大 CPS 与单行最长字数", () => {
    const ass = `[Script Info]\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n` +
      `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,正常一行字幕\n` +
      `Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,短句\n`;
    const m = measureAssSubtitles(ass);
    expect(m.entries).toBe(2);
    expect(m.maxCps).toBeCloseTo(6 / 2, 1); // 首行 6字/2s=3.0
    expect(m.maxLineChars).toBe(6);
    expect(m.violations).toEqual([]);
  });

  it("CPS 超 8 实测拦截", () => {
    const ass = `Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,这一秒钟塞了十个字啦\n`;
    const m = measureAssSubtitles(ass);
    expect(m.maxCps).toBeCloseTo(10, 0);
    expect(m.violations[0]).toContain("CPS=10.0");
  });
});

describe("runQualityGate 字幕项机器实测(声明=实测)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "av-qc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("报告带 generator 标记且字幕项为实测值", async () => {
    const video = join(dir, "v.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=6:size=1280x720:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-pix_fmt", "yuv420p", "-shortest", video]);
    const ass = join(dir, "final.ass");
    writeFileSync(ass, `Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,测试字幕一行\n`);
    const report = await runQualityGate(video, { subtitlePath: ass });
    expect(report.generator).toBe(QUALITY_REPORT_GENERATOR);
    const sub = report.checks.find((c) => c.key === "subtitle")!;
    expect(sub.level).toBe("pass");
    expect(sub.detail).toContain("实测最大 CPS=3.00"); // 6字/2s
  }, 60000);
});

describe("assembly 门禁拒绝手写质量报告", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-asm-"));
    mkdirSync(join(workDir, "output"), { recursive: true });
    writeFileSync(join(workDir, "output", "final.mp4"), "fake");
    writeFileSync(join(workDir, "output", "publish-text.md"), "t");
    writeFileSync(join(workDir, "output", "final.ass"), "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,字幕\n");
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  it("无 generator 标记(手写)→ 拦", () => {
    writeFileSync(join(workDir, "output", "quality-report.json"), JSON.stringify({ videoPath: join(workDir, "output", "final.mp4"), passed: true }));
    const issues = assertAssemblyDeliverables(workDir);
    expect(issues.some((i) => i.key === "quality_report" && i.detail.includes("非机器产物"))).toBe(true);
  });

  it("机器报告(generator 标记)→ 不拦报告项", () => {
    writeFileSync(join(workDir, "output", "quality-report.json"), JSON.stringify({
      generator: QUALITY_REPORT_GENERATOR, videoPath: join(workDir, "output", "final.mp4"), passed: true, createdAt: new Date().toISOString(),
    }));
    const issues = assertAssemblyDeliverables(workDir);
    expect(issues.filter((i) => i.key === "quality_report")).toEqual([]);
  });
});
