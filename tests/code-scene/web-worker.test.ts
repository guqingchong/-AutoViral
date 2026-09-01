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
});
