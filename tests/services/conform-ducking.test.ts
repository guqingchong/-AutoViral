import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformWork } from "../../src/services/conform.js";

// 2026-09-11(城市经营作品复盘):7 处旁白间隙 0.3~0.6s 近静音——agent 手搓
// sidechain 参数失当(release 过长/压太深)。conform 服务收纳标准 ducking:
// sidechaincompress(threshold=0.02 ratio=8 attack=20 release=400),间隙快速回升。
const dir = mkdtempSync(join(tmpdir(), "av-conform-"));
const seg = join(dir, "seg.mp4");
const narration = join(dir, "nar.wav");
const bgm = join(dir, "bgm.wav");

/** 读音频 RMS 电平(dB),用于验证 ducking 实际生效 */
function meanVolume(p: string): number {
  const out = execFileSync("ffmpeg", ["-i", p, "-af", "volumedetect", "-f", "null", "-"], { stdio: "pipe" }).toString();
  const m = out.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? parseFloat(m[1]) : NaN;
}

describe("conform 混音 ducking 标准化", () => {
  beforeAll(() => {
    // 2s 测试画面 + 旁白(880Hz 正弦)+ BGM(220Hz 正弦)
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", seg]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", narration]);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", bgm]);
  }, 60000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("默认 ducking:filtergraph 合法,成片带音轨", async () => {
    const out = join(dir, "out-duck.mp4");
    const r = await conformWork({ segments: [{ path: seg }], narration, bgm, width: 320, height: 240, fps: 10, output: out });
    expect(r.output).toBe(out);
    expect(existsSync(out)).toBe(true);
    const probe = execFileSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", out]).toString();
    const streams = JSON.parse(probe).streams;
    expect(streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  }, 120000);

  it("ducking:false → 静态 amix 老路径仍可用", async () => {
    const out = join(dir, "out-static.mp4");
    await conformWork({ segments: [{ path: seg }], narration, bgm, ducking: false, width: 320, height: 240, fps: 10, output: out });
    expect(existsSync(out)).toBe(true);
  }, 120000);

  it("ducking 自定义参数透传", async () => {
    const out = join(dir, "out-custom.mp4");
    await conformWork({
      segments: [{ path: seg }], narration, bgm,
      ducking: { threshold: 0.05, ratio: 4, attack: 40, release: 600 },
      width: 320, height: 240, fps: 10, output: out,
    });
    expect(existsSync(out)).toBe(true);
  }, 120000);
});
