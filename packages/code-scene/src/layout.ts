// 设计空间:所有模板场景按 1080x1920 调参,运行时按 view 实际尺寸等比缩放,
// 从而支持任意请求分辨率(工程债:布局硬编码参数化,2026-08-17)
export const DESIGN_W = 1080;
export const DESIGN_H = 1920;

/** view.size() → 设计空间的等比缩放系数(min 保证宽高都不溢出,同比例时精确) */
export function designScale(size: { x: number; y: number }): number {
  return Math.min(size.x / DESIGN_W, size.y / DESIGN_H);
}
