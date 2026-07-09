import { describe, it, expect, beforeEach } from "vitest";
import { parseFFmpegProgress } from "../../src/video/progress.js";
import { getFFmpegPath } from "../../src/video/ffmpeg.js";
import { resetFFmpegPathCache } from "../../src/video/ffmpeg.js";

describe("progress parser", () => {
  it("parses a typical FFmpeg progress line", () => {
    const line = "frame=  120 fps= 30 q=-1.0 size=     256kB time=00:00:04.00 bitrate= 525.3kbits/s speed=1.2x";
    const p = parseFFmpegProgress(line, 60);
    expect(p?.frame).toBe(120);
    expect(p?.fps).toBe(30);
    expect(p?.time).toBe(4);
    expect(p?.percent).toBeCloseTo(6.67, 1);
  });

  it("returns undefined for unrelated lines", () => {
    expect(parseFFmpegProgress("Output #0, mp4, to 'out.mp4':", 60)).toBeUndefined();
  });

  it("parses a progress line with fractional time", () => {
    const line = "frame=   50 fps= 25 q=28.0 size=     128kB time=00:00:02.04 bitrate= 514.0kbits/s speed=0.994x";
    const p = parseFFmpegProgress(line, 10);
    expect(p?.frame).toBe(50);
    expect(p?.fps).toBe(25);
    expect(p?.time).toBeCloseTo(2.04, 2);
    expect(p?.speed).toBe("0.994x");
    expect(p?.bitrate).toBe("514.0kbits/s");
    expect(p?.percent).toBeCloseTo(20.4, 1);
  });

  it("returns undefined for empty line", () => {
    expect(parseFFmpegProgress("", 60)).toBeUndefined();
  });

  it("handles missing duration gracefully", () => {
    const line = "frame=  120 fps= 30 time=00:00:04.00";
    const p = parseFFmpegProgress(line);
    expect(p?.frame).toBe(120);
    expect(p?.time).toBe(4);
    expect(p?.percent).toBeUndefined();
  });

  it("handles zero duration gracefully", () => {
    const line = "frame=  120 fps= 30 time=00:00:04.00";
    const p = parseFFmpegProgress(line, 0);
    expect(p?.frame).toBe(120);
    expect(p?.time).toBe(4);
    expect(p?.percent).toBeUndefined();
  });
});

describe("ffmpeg availability", () => {
  beforeEach(() => {
    resetFFmpegPathCache();
  });

  it("finds ffmpeg", async () => {
    const path = await getFFmpegPath();
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });
});
