/** buildFfmpegArgs 纯函数测试(2026-09-01 批次12b ffmpeg 参数化长任务) */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { buildFfmpegArgs } from "../../src/services/long-tasks.js";

const WORK_DIR = resolve("C:/data/works/w_test");
const LIST = join(WORK_DIR, "output", "lt_x.concat.txt");

describe("buildFfmpegArgs", () => {
  it("concat:demuxer + 流拷贝,inputs 逐个校验", () => {
    const args = buildFfmpegArgs({ op: "concat", inputs: ["clips/a.mp4", "clips/b.mp4"], output: "output/final.mp4" }, WORK_DIR, LIST);
    expect(args).toContain("concat");
    expect(args[args.length - 2]).toBe("-y");
    expect(args.at(-1)).toBe(resolve(WORK_DIR, "output/final.mp4"));
  });

  it("burn:ass 滤镜路径转义 + 视频重编码 + 音频拷贝", () => {
    const args = buildFfmpegArgs({ op: "burn", input: "output/raw.mp4", ass: "output/final.ass", output: "output/final.mp4" }, WORK_DIR, LIST);
    expect(args.join(" ")).toContain("ass='");
    expect(args).toContain("libx264");
  });

  it("loudnorm/tpad/trim 各成型", () => {
    expect(buildFfmpegArgs({ op: "loudnorm", input: "a.mp4", output: "o.mp4" }, WORK_DIR, LIST).join(" ")).toContain("loudnorm=I=-14");
    expect(buildFfmpegArgs({ op: "tpad", input: "a.mp4", output: "o.mp4", duration: 2.5 }, WORK_DIR, LIST).join(" ")).toContain("stop_duration=2.500");
    const trim = buildFfmpegArgs({ op: "trim", input: "a.mp4", output: "o.mp4", startTime: 3, duration: 10 }, WORK_DIR, LIST);
    expect(trim).toEqual(expect.arrayContaining(["-ss", "3", "-t", "10"]));
  });

  it("路径越界拒绝(防 ../ 逃逸)", () => {
    expect(() => buildFfmpegArgs({ op: "trim", input: "../outside.mp4", output: "o.mp4" }, WORK_DIR, LIST)).toThrow("越界");
    expect(() => buildFfmpegArgs({ op: "trim", input: "a.mp4", output: "../../o.mp4" }, WORK_DIR, LIST)).toThrow("越界");
  });

  it("缺参数报错", () => {
    expect(() => buildFfmpegArgs({ op: "concat", output: "o.mp4" }, WORK_DIR, LIST)).toThrow("inputs");
    expect(() => buildFfmpegArgs({ op: "tpad", input: "a.mp4", output: "o.mp4" }, WORK_DIR, LIST)).toThrow("duration");
  });
});
