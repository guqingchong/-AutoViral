/**
 * A3 图标/动效素材库(2026-08-14 素材来源扩展)。
 *
 * Iconify 离线图标集(mdi/tabler/lucide,共 7000+ 图标)→ SVG 内联服务。
 * 解决画面"空、素"的问题:图标风格统一、零生成成本、随取随用,
 * 供 HTML 渲染(图表卡/快照卡/图文卡/未来视频渲染层)内联调用。
 *
 * Lottie:本地 lottie JSON 文件 → 内联播放器 HTML 片段(浏览器渲染帧时播放)。
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const SETS = ["mdi", "tabler", "lucide"] as const;
export type IconSet = (typeof SETS)[number];

interface IconifySet {
  prefix: string;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
}

const setCache = new Map<string, IconifySet>();
function loadSet(set: string): IconifySet {
  const cached = setCache.get(set);
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const data = require(`@iconify-json/${set}/icons.json`) as IconifySet;
  setCache.set(set, data);
  return data;
}

export interface IconResult {
  set: string;
  name: string;
  svg: string;
}

/**
 * 取图标 SVG 字符串。color 默认 currentColor 由调用方 CSS 控制;
 * 显式传 color 则直接内联(HTML 渲染时不受外部 CSS 影响,更可控)。
 */
export function getIconSvg(set: string, name: string, opts?: { size?: number; color?: string }): string | null {
  let data: IconifySet;
  try {
    data = loadSet(set);
  } catch {
    return null;
  }
  let icon = data.icons[name];
  if (!icon && data.aliases?.[name]) icon = data.icons[data.aliases[name].parent];
  if (!icon) return null;
  const w = icon.width ?? data.width ?? 24;
  const h = icon.height ?? data.height ?? 24;
  const size = opts?.size ?? 24;
  const body = opts?.color
    ? icon.body.replace(/currentColor/g, opts.color)
    : icon.body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

/** 跨集搜索图标名(子串匹配),返回 "set:name" 列表 */
export function searchIcons(query: string, limit = 30): Array<{ set: string; name: string }> {
  const q = query.toLowerCase();
  const out: Array<{ set: string; name: string }> = [];
  for (const set of SETS) {
    let data: IconifySet;
    try {
      data = loadSet(set);
    } catch {
      continue;
    }
    for (const name of Object.keys(data.icons)) {
      if (name.includes(q)) {
        out.push({ set, name });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

let lottieJsCache: string | null = null;
async function loadLottieJs(): Promise<string> {
  if (lottieJsCache) return lottieJsCache;
  lottieJsCache = await readFile(require.resolve("lottie-web/build/player/lottie.min.js"), "utf-8");
  return lottieJsCache;
}

/**
 * 本地 lottie JSON → 可内联进 HTML 的播放器片段(浏览器渲染时自动播放)。
 * 用于未来视频渲染层的装饰动效;静态出图场景截取的是首帧。
 */
export async function buildLottieSnippet(lottieJsonPath: string, opts?: { width?: number; height?: number; loop?: boolean }): Promise<string> {
  const lottieJs = await loadLottieJs();
  const animationData = await readFile(lottieJsonPath, "utf-8");
  const w = opts?.width ?? 300;
  const h = opts?.height ?? 300;
  return `<div id="lottie-box" style="width:${w}px;height:${h}px"></div>
<script>${lottieJs}</script>
<script>
  lottie.loadAnimation({container:document.getElementById('lottie-box'),renderer:'svg',loop:${opts?.loop ?? false},autoplay:true,animationData:${animationData}});
</script>`;
}

/** 可用图标集清单 */
export function listIconSets(): Array<{ set: string; count: number }> {
  return SETS.map((set) => {
    try {
      return { set, count: Object.keys(loadSet(set).icons).length };
    } catch {
      return { set, count: 0 };
    }
  });
}
