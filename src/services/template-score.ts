/**
 * 模板质量评分(2026-08-14 模板精品化)。
 *
 * 把"精品"拆成机器可检的硬指标,每个模板给出 0-100 分和问题清单:
 *   - 可读性:字号下限、文字/背景对比度
 *   - 安全性:文字层是否侵入平台 UI 遮挡区(安全区)
 *   - 结构:图层数量合理性、变量化程度(可复用性)
 *   - 动感:是否有入场动效(无动效的模板播放效果呆板)
 *   - 时长:模板总时长合理性
 *
 * 用于:模板生成/克隆入库前自检、模板库批量体检、精品模板验收。
 */

import { contrastRatio, safeZoneFor, MIN_FONT_SIZE } from "./design-tokens.js";

export interface ScoreIssue {
  level: "warn" | "fail";
  rule: string;
  detail: string;
}

export interface TemplateScore {
  score: number;
  issues: ScoreIssue[];
}

interface LayerLike {
  id?: string;
  type?: string;
  content?: string;
  fontSize?: number;
  color?: string;
  fill?: string;
  start?: number;
  duration?: number;
  position?: { x?: number; y?: number } | string;
  size?: { width?: number; height?: number };
  animations?: unknown[];
}

interface TemplateLike {
  canvas?: { width?: number; height?: number };
  variables?: unknown[];
  layers?: LayerLike[];
}

export function scoreTemplate(tpl: TemplateLike): TemplateScore {
  const issues: ScoreIssue[] = [];
  const layers = tpl.layers ?? [];
  const canvas = { width: tpl.canvas?.width ?? 1080, height: tpl.canvas?.height ?? 1920 };
  const fontScale = canvas.width / 1080;
  const safe = safeZoneFor(canvas);
  const bg = (tpl.canvas as { backgroundColor?: string } | undefined)?.backgroundColor ?? "#0a0a0a";

  // 1. 图层数量
  if (layers.length === 0) {
    issues.push({ level: "fail", rule: "layers", detail: "没有任何图层" });
    return { score: 0, issues };
  }
  if (layers.length > 30) {
    issues.push({ level: "warn", rule: "layers", detail: `${layers.length} 个图层过于复杂,维护困难` });
  }

  // 2. 变量化(可复用性)
  const hasVars = (tpl.variables ?? []).length > 0;
  const hasVarRef = layers.some((l) => typeof l.content === "string" && /\{\{/.test(l.content));
  if (!hasVars && !hasVarRef) {
    issues.push({ level: "warn", rule: "variables", detail: "没有变量槽位,模板不可复用" });
  }

  // 3. 文字层检查:字号下限 + 对比度 + 安全区
  const textLayers = layers.filter((l) => l.type === "text");
  for (const l of textLayers) {
    const label = l.id ?? "text";
    const fontSize = l.fontSize ?? 40;
    if (fontSize < MIN_FONT_SIZE * fontScale) {
      issues.push({ level: "warn", rule: "font-size", detail: `文字层 ${label} 字号 ${fontSize}px 低于可读下限 ${Math.round(MIN_FONT_SIZE * fontScale)}px` });
    }
    // 对比度(文字色 vs 画布底色——层下有 shape 时实际更高,此处是保守下界)
    if (l.color && /^#/.test(l.color) && /^#/.test(bg)) {
      const ratio = contrastRatio(l.color, bg);
      if (ratio < 2.5) {
        issues.push({ level: "warn", rule: "contrast", detail: `文字层 ${label} 与底色对比度 ${ratio.toFixed(1)}:1 过低(<2.5:1)` });
      }
    }
    // 安全区(仅检查像素定位的文字层)
    if (typeof l.position === "object" && l.position) {
      const y = l.position.y ?? 0;
      if (y < safe.top * 0.6) {
        issues.push({ level: "warn", rule: "safe-zone", detail: `文字层 ${label} (y=${y}) 侵入顶部安全区(≈${safe.top}px)` });
      }
      if (y > canvas.height - safe.bottom) {
        issues.push({ level: "warn", rule: "safe-zone", detail: `文字层 ${label} (y=${y}) 侵入底部 UI 遮挡区(>${canvas.height - safe.bottom}px)` });
      }
    }
  }

  // 4. 动效
  const hasAnimation = layers.some((l) => Array.isArray(l.animations) && l.animations.length > 0);
  if (!hasAnimation) {
    issues.push({ level: "warn", rule: "motion", detail: "全模板无任何动效,播放效果呆板" });
  }

  // 5. 时长
  const total = Math.max(0, ...layers.map((l) => (l.start ?? 0) + (l.duration ?? 0)));
  if (total > 180) {
    issues.push({ level: "warn", rule: "duration", detail: `模板总时长 ${Math.round(total)}s 偏长(短视频建议 ≤90s;已支持素材驱动时长,此项仅提示)` });
  }

  // 计分:fail -25,warn -6,下限 0
  const score = Math.max(0, 100
    - issues.filter((i) => i.level === "fail").length * 25
    - issues.filter((i) => i.level === "warn").length * 6);
  return { score, issues };
}
