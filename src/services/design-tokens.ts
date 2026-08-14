/**
 * 设计规范 token(2026-08-14 模板精品化研究落地)。
 *
 * 来源:平台安全区规范(TikTok/抖音 UI 遮挡区)+ MoGRT 模板设计最佳实践
 * + 竖屏可读性研究。模板生成/评分/克隆共用这套 token,
 * 让"精品"从感觉变成可检查的硬指标。
 */

/** 竖屏 1080x1920 安全区:抖音底部 UI(标题/按钮)遮挡约 510px,顶部约 250px */
export interface SafeZone {
  top: number;
  bottom: number;
  side: number;
}

export function safeZoneFor(canvas: { width: number; height: number }): SafeZone {
  const ratio = canvas.height / canvas.width;
  if (ratio > 1.5) {
    // 竖屏 9:16:上 250 / 下 510 / 侧 65(1080x1920 基准,按比例缩放)
    const s = canvas.width / 1080;
    return { top: Math.round(250 * s), bottom: Math.round(510 * s), side: Math.round(65 * s) };
  }
  // 横屏 16:9:上下 8%,侧 6%
  return {
    top: Math.round(canvas.height * 0.08),
    bottom: Math.round(canvas.height * 0.08),
    side: Math.round(canvas.width * 0.06),
  };
}

/** 字号阶梯(1080 宽画布基准):小屏可读性研究下限 40pt ≈ 40px@1080 */
export const TYPE_SCALE = {
  /** 巨幕关键词 */
  display: 96,
  /** 主标题 */
  headline: 64,
  /** 副标题/卡片标题 */
  title: 44,
  /** 正文 */
  body: 32,
  /** 辅助说明(可读下限) */
  caption: 26,
} as const;

export const MIN_FONT_SIZE = 26; // 1080 宽画布的可读下限

/** 精选配色方案:bg/文字/强调色均经过对比度校验(WCAG 相对亮度 ≥ 4.5) */
export interface DesignPalette {
  key: string;
  label: string;
  background: string;
  surface: string;   // 卡片/色块底
  primary: string;   // 主强调
  accent: string;    // 次强调(点缀/高亮词)
  text: string;      // 主文字
  textMuted: string; // 次要文字
}

export const DESIGN_PALETTES: DesignPalette[] = [
  {
    key: "finance_dark", label: "财经深蓝",
    background: "#0f1b2d", surface: "#1e3a5f", primary: "#3b82f6", accent: "#f59e0b",
    text: "#f1f5f9", textMuted: "#94a3b8",
  },
  {
    key: "warm_gold", label: "暖黑金",
    background: "#161311", surface: "#2a241d", primary: "#d4af37", accent: "#e8c56b",
    text: "#f5efe0", textMuted: "#a89968",
  },
  {
    key: "ink_green", label: "墨绿知识",
    background: "#0d1f1a", surface: "#16352b", primary: "#3fd68f", accent: "#facc15",
    text: "#e8f5ee", textMuted: "#8fbc9f",
  },
  {
    key: "policy_red", label: "政策朱红",
    background: "#faf6f0", surface: "#ffffff", primary: "#c8102e", accent: "#1d4ed8",
    text: "#1c1917", textMuted: "#78716c",
  },
  {
    key: "violet_insight", label: "深紫洞察",
    background: "#17121f", surface: "#251c33", primary: "#a78bfa", accent: "#f472b6",
    text: "#ede9fe", textMuted: "#a396c4",
  },
];

/** WCAG 相对亮度(0-1) */
export function relativeLuminance(hex: string): number {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 对比度比值(1-21) */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
