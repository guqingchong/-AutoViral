/**
 * 模板级品牌 logo → 视频时间线 image 图层(2026-08-13 模板库改造 功能 c)。
 *
 * branding 存在模板 JSON(templates.branding 列),渲染前由 video-factory
 * 转成 image layer 追加进 layers——所有使用该模板的作品自动带 logo。
 * logo 文件在共享素材 branding 类(~/.autoviral/shared-assets/branding/),
 * 用本地绝对路径喂给 renderer(原样拼 ffmpeg -i,本地路径确定可用)。
 */

import { join } from "node:path";
import { dataDir } from "../config.js";
import type { TemplateBranding, TemplateCanvas } from "../db/templates-repo.js";
import type { ImageLayer } from "./types.js";

/** branding.logoAsset("branding/logo.png") → 本地绝对路径 */
export function brandingAssetPath(logoAsset: string): string {
  return join(dataDir, "shared-assets", logoAsset);
}

/** 九宫格位置 → 像素坐标(画布左上角原点)。
 *  注:以 size 框(宽=高=width)估算;非方形 logo 经 renderer decrease 缩放后
 *  实际高度更小,bottom 对齐时离底边会略远——九宫格是预设位置,视觉近似可接受。 */
export function brandingPixelPosition(
  branding: TemplateBranding,
  canvas: TemplateCanvas,
): { x: number; y: number } {
  const margin = branding.margin ?? 48;
  const width = branding.width ?? 160;
  const pos = branding.position;
  const x =
    pos.endsWith("left") ? margin
    : pos.endsWith("right") ? canvas.width - width - margin
    : Math.round((canvas.width - width) / 2);           // center 列
  const y =
    pos.startsWith("top") ? margin
    : pos.startsWith("bottom") ? canvas.height - width - margin
    : Math.round((canvas.height - width) / 2);          // middle 行
  return { x, y };
}

/**
 * branding → image layer。
 * size 高宽同值:renderer 的 scale 链用 force_original_aspect_ratio=decrease,
 * 只约束宽度即可自动等比,无需探测 logo 实际宽高比。
 *
 * contentDuration 必须传主内容时长(各层 start+duration 的最大值):
 * logo 时长不能超过内容时长,否则渲染输出长度会被拉到 logo 的时长
 * (2026-08-13 实测:duration=999999 导致渲染无限进行)。
 */
export function brandingToImageLayer(
  branding: TemplateBranding,
  canvas: TemplateCanvas,
  contentDuration: number,
): ImageLayer {
  const width = branding.width ?? 160;
  return {
    id: "__branding_logo",
    type: "image",
    source: brandingAssetPath(branding.logoAsset),
    start: 0,
    duration: Math.max(1, contentDuration),
    position: brandingPixelPosition(branding, canvas),
    size: { width, height: width },
    opacity: branding.opacity ?? 1,
  };
}
