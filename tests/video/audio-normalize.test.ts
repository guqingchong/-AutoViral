import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureAudioTrack, probeMedia, getFFmpegPath } from "../../src/video/ffmpeg.js";

const execFileAsync = promisify(execFile);

// 2026-09-18 实测根因(w_20260918_1519_b44 素材阶段 4 轮评审):程序化渲染
// (code-scene -an)与 stock 静音片天然无音频流,"视频无音频轨"是评审 Critical
// 常客。修复:收尾统一 ensureAudioTrack 归一化——无音轨补 48kHz 静音 AAC。

async function makeSilentVideo(path: string): Promise<void> {
  const ffmpeg = await getFFmpegPath();
  await execFileAsync(ffmpeg, [
    "-f", "lavfi", "-i", "testsrc=duration=1.2:size=320x240:rate=10",
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-y", path,
  ]);
}

describe("ensureAudioTrack 静音轨归一化", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "av-audionorm-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("无音轨视频 → 补静音 AAC 轨,时长与画面不变", async () => {
    const p = join(dir, "silent.mp4");
    await makeSilentVideo(p);
    expect((await probeMedia(p)).hasAudio).toBe(false); // 前置:确实无音轨

    const added = await ensureAudioTrack(p);
    expect(added).toBe(true);

    const after = await probeMedia(p);
    expect(after.hasAudio).toBe(true);
    expect(after.sampleRate).toBe(48000);
    expect(Math.abs((after.duration ?? 0) - 1.2)).toBeLessThan(0.3);
  });

  it("已有音轨视频 → 跳过不动", async () => {
    const p = join(dir, "withaudio.mp4");
    const ffmpeg = await getFFmpegPath();
    await execFileAsync(ffmpeg, [
      "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "-y", p,
    ]);
    expect((await probeMedia(p)).hasAudio).toBe(true); // 前置

    const added = await ensureAudioTrack(p);
    expect(added).toBe(false);
  });
});
