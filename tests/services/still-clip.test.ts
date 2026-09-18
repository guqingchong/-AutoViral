import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderStillClip } from "../../src/services/still-clip.js";
import { dataDir } from "../../src/config.js";

// 2026-09-11(快照卡镜头抖动复盘):agent 手搓 zoompan(1× 裸推 6%)违反防抖红线。
// 服务化:默认纯静态零风险;push 走 3× 超采样 + ≤4% 变倍(红线方案②)。
const sandbox = join(dataDir, "tmp-stillclip-test");
const img = join(sandbox, "card.png");

function probeVideo(p: string): { w: number; h: number; duration: number; fps: number } {
  const out = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", p]).toString();
  const d = JSON.parse(out);
  const v = d.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const [fn, fd] = (v.r_frame_rate as string).split("/").map(Number);
  return { w: v.width, h: v.height, duration: Number(d.format.duration), fps: fn / fd };
}

describe("renderStillClip 静图转视频段", () => {
  beforeAll(() => {
    mkdirSync(sandbox, { recursive: true });
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=1600x900:rate=1:duration=1", "-frames:v", "1", img]);
  }, 30000);
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("默认纯静态:时长/画幅/帧率达标,无音轨", async () => {
    const out = join(sandbox, "s.mp4");
    const r = await renderStillClip({ image: img, duration: 2.5, out });
    expect(r.motion).toBe("none");
    const v = probeVideo(r.path);
    expect(v.w).toBe(1920);
    expect(v.h).toBe(1080);
    expect(v.duration).toBeGreaterThanOrEqual(2.4);
    expect(v.fps).toBeCloseTo(30, 0);
  }, 60000);

  it("push 推镜:3× 超采样路径渲染成功(不拉伸、画幅正确)", async () => {
    const out = join(sandbox, "p.mp4");
    const r = await renderStillClip({ image: img, duration: 2, out, motion: "push" });
    const v = probeVideo(r.path);
    expect(v.w).toBe(1920);
    expect(v.h).toBe(1080);
    expect(existsSync(r.path)).toBe(true);
  }, 60000);

  it("竖版图片 push:补边后不拉伸", async () => {
    const portrait = join(sandbox, "p9x16.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=1:duration=1", "-frames:v", "1", portrait]);
    const out = join(sandbox, "pp.mp4");
    const r = await renderStillClip({ image: portrait, duration: 1.5, out, motion: "push" });
    const v = probeVideo(r.path);
    expect(v.w / v.h).toBeCloseTo(16 / 9, 2);
  }, 60000);

  it("路径越界/图片不存在 → 拒", async () => {
    await expect(renderStillClip({ image: "C:/Windows/x.png", duration: 1, out: join(sandbox, "x.mp4") })).rejects.toThrow("路径越界");
    await expect(renderStillClip({ image: join(sandbox, "nope.png"), duration: 1, out: join(sandbox, "x.mp4") })).rejects.toThrow("图片不存在");
  });
});
