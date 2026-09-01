// 设计空间:所有模板场景按 1080x1920 调参,运行时按 view 实际尺寸等比缩放,
// 从而支持任意请求分辨率(工程债:布局硬编码参数化,2026-08-17)
export const DESIGN_W = 1080;
export const DESIGN_H = 1920;

/** view.size() → 设计空间的等比缩放系数(min 保证宽高都不溢出,同比例时精确) */
export function designScale(size: { x: number; y: number }): number {
  return Math.min(size.x / DESIGN_W, size.y / DESIGN_H);
}

/**
 * 字幕安全区(2026-09-01 视觉升级 05 方案 S1):
 * 设计空间中心原点,y ∈ [458, 602],基线 530 = 屏幕第 1490 行(ass MarginV=430,
 * 贴抖音底部 UI 遮挡区 y>1536 上沿——位置受平台 UI 约束,非纯审美选择)。
 * 所有模板内容禁止进入该区;字幕胶囊垂直中心落于此带。
 * 三方镜像:本文件(TS 模板侧)/ design-tokens.css(--safe-zone-h: 144px)/
 * caption_generate.py(margin_v=430)——tests/code-scene/safe-zone.test.ts 做一致性校验。
 */
export const SUBTITLE_ZONE = { yMin: 458, yMax: 602 } as const;
/** 左右边距 */
export const MARGIN = 96;
/** 内容区上限(顶部留白 144px) */
export const CONTENT_TOP = -816;
