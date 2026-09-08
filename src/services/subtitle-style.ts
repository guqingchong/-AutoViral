/**
 * 字幕样式参数化(改造项 R3,2026-09-03 批次)。
 *
 * 背景:renderer.ts:238 的 `force_style='FontSize=48,...'` 硬编码在滤镜里,无样式选择。
 * 本模块把 force_style 串生成抽出,支持四种 preset,供 renderer.ts 的
 * `buildFilterComplexArgs` 以 `buildAssHeader(tl.subtitleStyle)` 替代硬编码。
 * 依赖 R2(预渲染路径上做逐词变色更顺)——但本文件本身只产出样式串,不依赖其他模块。
 *
 * 注意:force_style 参数值内的 `&H` 用 `&` 转义,且整段被 `force_style='...'` 单引号包裹,
 * 与 renderer.ts 现有 `subtitles=...:force_style='...'` 用法一致(供主会话接入时参考)。
 */

/** 各 preset 的 ASS force_style 内参串(不含 `force_style='...'` 外壳)。 */
export const PRESETS: Record<string, string> = {
  // 抖音主打:大字号 + 粗描边,白字黑边,文字醒目压得住画面
  "douyin-highlight":
    "FontSize=52,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,Outline=3,Bold=1,Shadow=1,MarginV=70",
  // 抖音粗体:比 highlight 更大更粗,强调标题级字幕
  "douyin-bold":
    "FontSize=56,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,Outline=4,Bold=1,Shadow=2,MarginV=80",
  // 小红书柔和:小一号 + 细描边,整体更轻、不抢画面,阴影更弱
  "xhs-soft":
    "FontSize=46,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00555555&,Outline=2,Bold=0,Shadow=0,MarginV=60",
  // 极简:最小字号 + 无描边阴影,仅保留白字,适合沉浸式画面
  "minimal":
    "FontSize=40,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,Outline=0,Bold=0,Shadow=0,MarginV=50",
};

export type SubtitlePreset = keyof typeof PRESETS;

const DEFAULT_PRESET: SubtitlePreset = "douyin-highlight";

export interface BuildAssHeaderOptions {
  /** 覆盖预设字号(px),用于细粒度调整。缺省用预设内置的 FontSize。 */
  fontSize?: number;
}

/**
 * 生成 ASS subtitles 滤镜可用的 force_style 串。
 *
 * @param preset 样式预设,∈ douyin-highlight|douyin-bold|xhs-soft|minimal,缺省 douyin-highlight
 * @param opts   可选:fontSize 覆盖字号
 * @returns 形如 `force_style='FontSize=52,...'` 的完整参数串,可直接接在 `subtitles=...:` 之后
 */
export function buildAssHeader(
  preset: string,
  opts?: BuildAssHeaderOptions
): string {
  const base = PRESETS[preset] ?? PRESETS[DEFAULT_PRESET];
  let style = base;
  if (opts?.fontSize && opts.fontSize > 0) {
    // 用正则替换已有的 FontSize= 值,避免产出重复字段
    style = style.replace(/FontSize=\d+/, `FontSize=${opts.fontSize}`);
  }
  return `force_style='${style}'`;
}

export default buildAssHeader;
