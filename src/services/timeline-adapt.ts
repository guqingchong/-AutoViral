/**
 * 素材驱动的时长适配(2026-08-13 用户决策:模板取消时长约束)。
 *
 * 原则:模板只约束视觉呈现(版式/配色/字体/动效节奏),成片时长完全
 * 实事求是地由素材(=脚本规划的物化)决定。渲染前对时间轴做适配:
 *
 *   1. 按场景检测(template-scenes)把图层分幕;
 *   2. 每幕时长 = 该幕主素材(面积最大的 video 层)的实际时长(ffprobe);
 *      该幕没有视频素材 → 保留模板原幕长;
 *   3. 幕内图层的 start/duration 按比例映射到新幕长(保持视觉节奏);
 *   4. 全局层(时长覆盖原总时长 70% 以上,如全程字幕)贯穿新总时长;
 *   5. video/image 层的素材截取起点归 0(sourceStart)——模板层的 start
 *      是时间轴位置,不再兼任素材裁剪起点(否则短素材被 trim 空)。
 *
 * 不做"按模板时长缩放脚本"——方向相反:模板节奏向素材实际时长对齐。
 */

import { existsSync } from "node:fs";
import { probeMedia } from "../video/ffmpeg.js";
import { detectScenes, sceneIndexOfLayer } from "./template-scenes.js";
import type { Timeline, TimelineLayer } from "../video/types.js";

/** 全局层判定阈值:层时长 ≥ 原总时长的 70% */
const GLOBAL_LAYER_RATIO = 0.7;

/** 可注入的素材时长探针(测试用);默认 ffprobe */
export type DurationProbe = (path: string) => Promise<number | undefined>;

const defaultProbe: DurationProbe = async (path) => {
  if (!existsSync(path)) return undefined;
  const info = await probeMedia(path);
  return info.duration && info.duration > 0 ? info.duration : undefined;
};

export async function adaptTimelineToAssets(timeline: Timeline, probe: DurationProbe = defaultProbe): Promise<Timeline> {
  const scenes = detectScenes(timeline.layers, timeline.canvas);
  if (scenes.length === 0) return timeline;
  const oldTotal = Math.max(1, ...timeline.layers.map((l) => l.start + l.duration));

  // 逐幕确定新时长:主素材(该幕开始的、面积最大的 video 层)实际时长
  const newSceneDurations: number[] = [];
  for (const scene of scenes) {
    const oldDur = scene.end - scene.start;
    let driver: Extract<TimelineLayer, { type: "video" }> | undefined;
    for (const l of timeline.layers) {
      if (l.type !== "video") continue;
      const start = l.start ?? 0;
      if (start < scene.start - 0.01 || start >= scene.end - 0.01) continue;
      if (!driver || (l.size.width * l.size.height) > (driver.size.width * driver.size.height)) driver = l;
    }
    if (driver) {
      const assetDur = await probe(driver.source);
      newSceneDurations.push(assetDur && assetDur >= 0.3 ? assetDur : oldDur);
    } else {
      newSceneDurations.push(oldDur);
    }
  }

  // 各幕新起点:顺序紧凑排列(幕与幕在模板里本就首尾相接)
  const newSceneStarts: number[] = [];
  let cursor = 0;
  for (const d of newSceneDurations) { newSceneStarts.push(cursor); cursor += d; }
  const newTotal = Math.max(1, cursor);

  const layers = timeline.layers.map((layer) => {
    // 全局层(全程字幕/logo 底等):贯穿新总时长
    if (layer.duration >= oldTotal * GLOBAL_LAYER_RATIO) {
      return { ...layer, start: 0, duration: newTotal };
    }
    const idx = sceneIndexOfLayer(layer, scenes);
    const scene = scenes[idx];
    const oldDur = scene.end - scene.start;
    const scale = oldDur > 0 ? newSceneDurations[idx] / oldDur : 1;
    const adapted = {
      ...layer,
      start: newSceneStarts[idx] + (layer.start - scene.start) * scale,
      duration: Math.max(0.1, layer.duration * scale),
    };
    // 素材从头部播:层 start 是时间轴位置,不再兼任素材裁剪起点
    if (adapted.type === "video" || adapted.type === "image") {
      (adapted as { sourceStart?: number }).sourceStart = 0;
    }
    return adapted;
  });

  return { ...timeline, layers };
}
