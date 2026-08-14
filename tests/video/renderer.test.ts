import { describe, it, expect } from "vitest";
import { collectInputs, buildFilterComplexArgs, computeDuration } from "../../src/video/renderer.js";
import type { Timeline } from "../../src/video/types.js";

function sampleTimeline(): Timeline {
  return {
    canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#000000" },
    layers: [
      { id: "host", type: "video", source: "/tmp/host.mp4", start: 0, duration: 60, position: "center", size: { width: 1080, height: 1920 } },
      { id: "title", type: "text", content: "标题", start: 0, duration: 5, position: "top", fontSize: 60 },
    ],
    audio: [
      { type: "voice", source: "/tmp/voice.wav", volume: 1 },
      { type: "bgm", source: "/tmp/bgm.mp3", volume: 0.3 },
    ],
  };
}

describe("renderer command builder", () => {
  it("collects inputs in order", () => {
    const inputs = collectInputs(sampleTimeline());
    expect(inputs.length).toBe(3);
    expect(inputs[0].type).toBe("video");
    expect(inputs[1].type).toBe("audio");
    expect(inputs[2].type).toBe("audio");
  });

  it("computes timeline duration", () => {
    expect(computeDuration(sampleTimeline())).toBe(60);
  });

  it("builds filter_complex args", () => {
    const tl = sampleTimeline();
    const inputs = collectInputs(tl);
    const args = buildFilterComplexArgs(tl, inputs, 60, "/tmp/out.mp4");
    expect(args).toContain("-filter_complex");
    expect(args).toContain("-y");
    expect(args).toContain("/tmp/out.mp4");
    const fcIndex = args.indexOf("-filter_complex");
    const fc = args[fcIndex + 1];
    expect(fc).toContain("[0:v]");
    expect(fc).toContain("drawtext");
    expect(fc).toContain("amix");
  });

  it("validates overlay filter chain syntax", () => {
    const tl: Timeline = {
      canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#000000" },
      layers: [
        { id: "host", type: "video", source: "/tmp/host.mp4", start: 0, duration: 60, position: "center", size: { width: 1080, height: 1920 } },
        { id: "logo", type: "image", source: "/tmp/logo.png", start: 0, duration: 60, position: "top", size: { width: 200, height: 200 } },
      ],
      audio: [],
    };
    const inputs = collectInputs(tl);
    const args = buildFilterComplexArgs(tl, inputs, 60, "/tmp/out.mp4");
    const fcIndex = args.indexOf("-filter_complex");
    const fc = args[fcIndex + 1];
    // 2026-08-13 修复后结构:overlay 媒体流独立成段贴标签,再 overlay 到 [base]
    // (旧结构 `[base][1:v]trim=...` 使 trim 拿到两个输入标签,ffmpeg 必失败)
    // C1: overlay 流独立成段
    expect(fc).toMatch(/\[1:v\]trim=[^;]*setsar=1[^;]*\[ovl_logo\]/);
    // C2: 合成段引用标签 overlay 到 base
    expect(fc).toContain("[base][ovl_logo]overlay=");
    // C3: overlay 流段内不得出现 [base](trim 双输入 bug 的回归防护)
    const ovlSegment = fc.split(";").find((s) => s.includes("[ovl_logo]") && s.includes("trim"));
    expect(ovlSegment).toBeDefined();
    expect(ovlSegment).not.toContain("[base]");
    // C4: no invalid :format=yuva420p on overlay
    expect(fc).not.toMatch(/overlay=[^\[;]*:format=yuva420p/);
  });

  it("escapes apostrophes in drawtext", () => {
    const tl: Timeline = {
      canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#000000" },
      layers: [
        { id: "title", type: "text", content: "It's working", start: 0, duration: 5, position: "top", fontSize: 60 },
      ],
      audio: [],
    };
    const inputs = collectInputs(tl);
    const args = buildFilterComplexArgs(tl, inputs, 5, "/tmp/out.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("drawtext");
    expect(fc).toContain("It'\\''s working");
  });

  it("appends subtitles filter when subtitles are present", () => {
    const tl: Timeline = {
      ...sampleTimeline(),
      subtitles: { source: "/tmp/subtitles.srt" },
    };
    const inputs = collectInputs(tl);
    const args = buildFilterComplexArgs(tl, inputs, 60, "/tmp/out.mp4");
    const fcIndex = args.indexOf("-filter_complex");
    const fc = args[fcIndex + 1];
    expect(fc).toContain("subtitles=/tmp/subtitles.srt");
    expect(fc).toContain("force_style=");
  });
});
