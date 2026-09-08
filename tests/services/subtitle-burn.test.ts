import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { burnSubtitlesFast } from "../../src/services/subtitle-burn.js";

const execFileAsync = promisify(execFile);
const hasFfmpeg = await execFileAsync("ffmpeg", ["-version"]).then(() => true).catch(() => false);

/**
 * P4 实证测试(2026-09-08):overlay 主/叠顺序修复后,产物抽帧必须真能看见字幕。
 * 旧写法 [1:v][0:v]overlay 主叠颠倒——正片盖住字幕层,exit code 正常但成片无字幕,
 * 只验退出码验不出来,必须抽帧读图。
 *
 * 判定方式:正片造纯黑底,字幕样式白色大字;烧录后抽中间帧,
 * 画面应存在大量高亮(字幕)像素;若顺序颠倒(正片盖住字幕)则帧仍近全黑。
 */
describe.skipIf(!hasFfmpeg)("burnSubtitlesFast 实证(P4)", () => {
  let dir: string;
  const W = 320, H = 568, FPS = 10, DUR_S = 3;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-burnfast-"));
    // 3s 纯黑正片(带静音轨,模拟真实产物)
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=${DUR_S}`,
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-t", String(DUR_S),
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      join(dir, "main.mp4"),
    ]);
    // 含 \kf 逐字效果的 ASS(触发快路径的典型输入),白色底部大字
    const ass = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: " + W,
      "PlayResY: " + H,
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,2,10,10,40,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,{\\kf30}测{\\kf30}试{\\kf30}字{\\kf30}幕",
      "",
    ].join("\n");
    await writeFile(join(dir, "subs.ass"), ass, "utf-8");
  }, 120_000);

  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("含 \\kf 字幕烧录后抽中间帧可见字幕像素", async () => {
    const out = join(dir, "out.mp4");
    await burnSubtitlesFast(join(dir, "main.mp4"), join(dir, "subs.ass"), out, DUR_S * FPS, { width: W, height: H, fps: FPS });

    // 抽 1.5s 处一帧为 PNG,读原始像素统计高亮像素
    const frame = join(dir, "mid.png");
    await execFileAsync("ffmpeg", ["-y", "-ss", "1.5", "-i", out, "-frames:v", "1", frame]);
    const png = await readFile(frame);
    // PNG 解码依赖太重——改用 ffmpeg 直接输出 gray rawvideo 统计
    const raw = join(dir, "mid.gray");
    await execFileAsync("ffmpeg", ["-y", "-ss", "1.5", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw]);
    const buf = await readFile(raw);
    expect(buf.length).toBe(W * H);
    let bright = 0;
    for (const b of buf) if (b > 128) bright++;
    // 纯黑底 + 白字:字幕应占画面的可观比例(4 个大字,320x568 下保守 >0.5%);
    // 顺序颠倒时(正片盖字幕)bright = 0
    expect(bright / buf.length).toBeGreaterThan(0.005);
    void png;
  }, 120_000);
});
