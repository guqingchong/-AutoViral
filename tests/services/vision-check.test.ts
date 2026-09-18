import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runVisionCheck } from "../../src/services/vision-check.js";
import { dataDir } from "../../src/config.js";
import type { Config } from "../../src/config.js";

// 2026-09-11(assets 复盘改进点 3):视觉核验服务化——
// 消灭 agent 手搓 vision-check.mjs + sleep 轮询(空等约 20 分钟)。
const sandbox = join(dataDir, "tmp-vcheck-test");
const emptyCfg = {} as Config; // 无视觉模型配置:走通前置校验后在 LLM 阶段报"未配置"

describe("runVisionCheck 入参与路径安全", () => {
  beforeAll(() => {
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "ok.jpg"), Buffer.from([0xff, 0xd8, 0xff])); // 伪 jpg 头即可(存在性/扩展名校验)
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("prompt 缺失 → 拒", async () => {
    await expect(runVisionCheck({ images: ["a.jpg"], prompt: "" }, emptyCfg)).rejects.toThrow("prompt 必填");
  });

  it("images/video 都缺 → 拒", async () => {
    await expect(runVisionCheck({ prompt: "看图" }, emptyCfg)).rejects.toThrow("images 或 video 必须提供一个");
  });

  it("路径越界(dataDir 之外)→ 拒", async () => {
    await expect(runVisionCheck({ images: ["C:/Windows/system32/x.jpg"], prompt: "看图" }, emptyCfg)).rejects.toThrow("路径越界");
    await expect(runVisionCheck({ images: ["../../etc/passwd"], prompt: "看图" }, emptyCfg)).rejects.toThrow("路径越界");
  });

  it("图片不存在 → 拒", async () => {
    await expect(runVisionCheck({ images: [join(sandbox, "nope.jpg")], prompt: "看图" }, emptyCfg)).rejects.toThrow("图片不存在");
  });

  it("单次超 8 张 → 拒", async () => {
    const nine = Array.from({ length: 9 }, () => join(sandbox, "ok.jpg"));
    await expect(runVisionCheck({ images: nine, prompt: "看图" }, emptyCfg)).rejects.toThrow("最多核验 8 张");
  });
});

describe("runVisionCheck 视频抽帧(ffmpeg 实测)", () => {
  beforeAll(() => {
    mkdirSync(sandbox, { recursive: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=160x90:rate=10", join(sandbox, "v.mp4")]);
  });

  it("抽帧走通到视觉模型阶段(无配置报未配置,证明帧已抽出)", async () => {
    await expect(runVisionCheck({ video: { path: join(sandbox, "v.mp4"), times: [0.5, 1.5] }, prompt: "输出 {}" }, emptyCfg))
      .rejects.toThrow(/视觉模型|未配置/);
  });

  it("视频不存在 → 拒", async () => {
    await expect(runVisionCheck({ video: { path: join(sandbox, "nope.mp4") }, prompt: "输出 {}" }, emptyCfg)).rejects.toThrow("视频不存在");
  });
});
