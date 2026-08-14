import { describe, it, expect } from "vitest";
import { detectScenes } from "../../src/services/template-scenes.js";
import { adaptTimelineToAssets } from "../../src/services/timeline-adapt.js";
import type { Timeline } from "../../src/video/types.js";

describe("detectScenes 场景检测", () => {
  const canvas = { width: 1280, height: 720 };

  it("全屏底版/主视频层的 start 聚类成场景边界", () => {
    const layers = [
      { type: "shape", start: 0, duration: 115, size: { width: 1280, height: 720 } },
      { type: "video", start: 0, duration: 115, size: { width: 350, height: 530 } },
      { type: "video", start: 115, duration: 115, size: { width: 1280, height: 720 } },
      { type: "shape", start: 230, duration: 115, size: { width: 1280, height: 720 } },
      { type: "text", start: 231, duration: 5 }, // 小元素不构成场景边界
    ];
    const scenes = detectScenes(layers, canvas);
    expect(scenes.map((s) => s.start)).toEqual([0, 115, 230]);
    expect(scenes[2].end).toBe(345);
  });

  it("全部图层 start=0 → 单场景", () => {
    const layers = [
      { type: "video", start: 0, duration: 5, size: { width: 1080, height: 1920 } },
      { type: "shape", start: 0, duration: 5, size: { width: 1080, height: 200 } },
      { type: "text", start: 0.5, duration: 4.5 },
    ];
    expect(detectScenes(layers, canvas)).toHaveLength(1);
  });

  it("亚秒级参差的锚定 start 聚类为同一场景", () => {
    const layers = [
      { type: "shape", start: 0, duration: 100, size: { width: 1280, height: 720 } },
      { type: "video", start: 100, duration: 100, size: { width: 1280, height: 720 } },
      { type: "shape", start: 100.5, duration: 99.5, size: { width: 830, height: 580 } },
    ];
    expect(detectScenes(layers, canvas)).toHaveLength(2);
  });
});

describe("adaptTimelineToAssets 素材驱动时长", () => {
  const baseTimeline = (): Timeline => ({
    canvas: { width: 1280, height: 720, fps: 30 },
    audio: [],
    layers: [
      { id: "bgA", type: "shape", shape: "rect", fill: "#111", start: 0, duration: 10, position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
      { id: "clipA", type: "video", source: "/a.mp4", start: 0, duration: 10, position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
      { id: "txtA", type: "text", content: "A幕标题", start: 5, duration: 5, position: { x: 100, y: 100 } },
      { id: "bgB", type: "shape", shape: "rect", fill: "#222", start: 10, duration: 10, position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
      { id: "clipB", type: "video", source: "/b.mp4", start: 10, duration: 10, position: { x: 0, y: 0 }, size: { width: 1280, height: 720 } },
      { id: "subtitle", type: "text", content: "全程字幕", start: 0, duration: 20, position: "bottom" },
    ],
  });

  it("每幕时长=主素材实际时长,幕内图层保持相对节奏,全局层贯穿新总时长", async () => {
    const probe = async (p: string) => (p === "/a.mp4" ? 6 : p === "/b.mp4" ? 4 : undefined);
    const out = await adaptTimelineToAssets(baseTimeline(), probe);
    const byId = Object.fromEntries(out.layers.map((l) => [l.id, l]));

    // A 幕 10s→6s,B 幕紧随其后 6→10(4s)
    expect(byId["clipA"].start).toBe(0);
    expect(byId["clipA"].duration).toBe(6);
    expect(byId["clipB"].start).toBe(6);
    expect(byId["clipB"].duration).toBe(4);
    // A 幕内文本层比例映射:5/10→3s 处,时长 5→3
    expect(byId["txtA"].start).toBeCloseTo(3);
    expect(byId["txtA"].duration).toBeCloseTo(3);
    // 全局字幕层贯穿新总时长 10s
    expect(byId["subtitle"].start).toBe(0);
    expect(byId["subtitle"].duration).toBe(10);
    // 素材从头部播
    expect((byId["clipA"] as { sourceStart?: number }).sourceStart).toBe(0);
    expect((byId["clipB"] as { sourceStart?: number }).sourceStart).toBe(0);
  });

  it("探测不到素材时长的幕保留模板原幕长", async () => {
    const probe = async () => undefined;
    const out = await adaptTimelineToAssets(baseTimeline(), probe);
    const byId = Object.fromEntries(out.layers.map((l) => [l.id, l]));
    expect(byId["clipA"].duration).toBe(10);
    expect(byId["clipB"].start).toBe(10);
    expect(byId["subtitle"].duration).toBe(20);
  });

  it("纯图文模板(无视频层)时间轴不变", async () => {
    const tl: Timeline = {
      canvas: { width: 1080, height: 1920, fps: 30 },
      audio: [],
      layers: [
        { id: "bg", type: "shape", shape: "rect", fill: "#000", start: 0, duration: 5, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
        { id: "t", type: "text", content: "标题", start: 0.5, duration: 2, position: { x: 80, y: 200 } },
      ],
    };
    const out = await adaptTimelineToAssets(tl, async () => undefined);
    expect(out.layers).toEqual(tl.layers);
  });
});
