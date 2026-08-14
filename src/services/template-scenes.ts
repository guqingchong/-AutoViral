/**
 * 模板场景(分幕)检测(2026-08-13,故事板分图与素材驱动时长共用)。
 *
 * 场景边界 = 锚定图层的 start 聚类:全屏/半屏以上的 shape 底版、video/image
 * 主素材层的出现即一幕的开始。克隆视频有几幕,就检出几幕——不固定数量。
 */

export interface TemplateScene {
  start: number;
  end: number;
}

interface SceneLayerLike {
  type?: string;
  start?: number;
  duration?: number;
  size?: { width?: number; height?: number };
}

/** 同一幕内多个锚定层(底版+主素材)start 可能有亚秒级参差,聚类容差 1s */
const CLUSTER_TOLERANCE = 1.0;
/** shape 面积占画布 50% 以上视为幕底版 */
const BG_AREA_RATIO = 0.5;

export function detectScenes(
  layers: SceneLayerLike[],
  canvas: { width?: number; height?: number },
): TemplateScene[] {
  const total = Math.max(1, ...layers.map((l) => (l.start ?? 0) + (l.duration ?? 0)));
  const canvasArea = (canvas.width ?? 1080) * (canvas.height ?? 1920);

  const anchorStarts: number[] = [];
  for (const l of layers) {
    const start = l.start ?? 0;
    if (l.type === "video" || l.type === "image") {
      anchorStarts.push(start);
    } else if (l.type === "shape") {
      const area = (l.size?.width ?? 0) * (l.size?.height ?? 0);
      if (area >= canvasArea * BG_AREA_RATIO) anchorStarts.push(start);
    }
  }

  const sorted = [...new Set(anchorStarts)].sort((a, b) => a - b);
  const boundaries: number[] = [];
  for (const s of sorted) {
    if (boundaries.length === 0 || s - boundaries[boundaries.length - 1] > CLUSTER_TOLERANCE) {
      boundaries.push(s);
    }
  }
  if (boundaries.length === 0 || boundaries[0] > 0) boundaries.unshift(0);

  return boundaries.map((start, i) => ({
    start,
    end: i + 1 < boundaries.length ? boundaries[i + 1] : total,
  }));
}

/** 图层归属于哪一幕:按 start 落在的场景区间(从后往前找,start 越靠后归属越后的幕) */
export function sceneIndexOfLayer(layer: SceneLayerLike, scenes: TemplateScene[]): number {
  const start = layer.start ?? 0;
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (start >= scenes[i].start - 0.01) return i;
  }
  return 0;
}
