/**
 * 模板程序化质检（2026-08-03 Phase B）。
 *
 * LLM 生成模板后、入库前跑一遍硬性设计规则检查，输出人类可读的问题清单。
 * 有问题的模板连同问题清单喂回 LLM 自修复（最多 2 轮），从源头拦截"丑模板"：
 * 颜色格式非法、元素出画布、对比度不足、字号层级塌陷、变量引用悬空、时序错误。
 */

export interface QualityIssue {
  /** 规则代码，便于测试断言 */
  rule: string;
  /** 面向 LLM 修复的具体描述（含图层 id 和期望值） */
  message: string;
}

interface RawLayer {
  id?: string;
  type?: string;
  start?: number;
  duration?: number;
  position?: { x?: number; y?: number };
  size?: { width?: number; height?: number };
  content?: string;
  fontSize?: number;
  color?: string;
  fill?: string;
}

interface RawTemplate {
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number; backgroundColor?: string };
  variables?: Array<{ name?: string; type?: string }>;
  layers?: RawLayer[];
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** sRGB 相对亮度（WCAG） */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度（1..21） */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function findBgUnderLayer(layers: RawLayer[], target: RawLayer, canvasBg: string): string {
  // 找 target 之下（数组中先于它出现）、与其位置区域有交叠的最后一个 shape 作为其底色
  const tx = target.position?.x ?? 0;
  const ty = target.position?.y ?? 0;
  let bg = canvasBg;
  for (const l of layers) {
    if (l === target) break;
    if (l.type !== "shape") continue;
    const lx = l.position?.x ?? 0;
    const ly = l.position?.y ?? 0;
    const lw = l.size?.width ?? 0;
    const lh = l.size?.height ?? 0;
    if (tx >= lx && tx <= lx + lw && ty >= ly && ty <= ly + lh) {
      bg = typeof l.fill === "string" && HEX_RE.test(l.fill) ? l.fill : bg;
    }
  }
  return bg;
}

/**
 * 质检入口。raw 是 LLM 输出（尚未 normalize），只查"丑/错"不查 schema 合法性
 * （schema 由 validateTemplate 兜底）。
 */
export function checkTemplateQuality(raw: RawTemplate): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const canvas = raw.canvas ?? {};
  const W = canvas.width ?? 1080;
  const H = canvas.height ?? 1920;
  const canvasBg = typeof canvas.backgroundColor === "string" && HEX_RE.test(canvas.backgroundColor)
    ? canvas.backgroundColor
    : "#000000";
  const layers = Array.isArray(raw.layers) ? raw.layers : [];
  const variables = new Set((Array.isArray(raw.variables) ? raw.variables : []).map((v) => v?.name).filter(Boolean));

  // ── 1. 颜色格式：一律 #RRGGBB 实色（渲染器不支持 rgba/半透明） ──
  if (canvas.backgroundColor && !HEX_RE.test(canvas.backgroundColor)) {
    issues.push({ rule: "color-format", message: `canvas.backgroundColor="${canvas.backgroundColor}" 不是 #RRGGBB 六位实色` });
  }
  for (const l of layers) {
    const id = l.id ?? "?";
    if (l.type === "text" && l.color && !HEX_RE.test(l.color)) {
      issues.push({ rule: "color-format", message: `文字层 "${id}" 的 color="${l.color}" 不是 #RRGGBB 六位实色` });
    }
    if (l.type === "shape" && l.fill && !HEX_RE.test(l.fill)) {
      issues.push({ rule: "color-format", message: `形状层 "${id}" 的 fill="${l.fill}" 不是 #RRGGBB 六位实色（禁止半透明/渐变写法）` });
    }
  }

  // ── 2. 画布边界：元素不得超出画布（允许 1px 误差） ──
  for (const l of layers) {
    const id = l.id ?? "?";
    const x = l.position?.x ?? 0;
    const y = l.position?.y ?? 0;
    const w = l.size?.width ?? 0;
    const h = l.size?.height ?? 0;
    if (x < -1 || y < -1) {
      issues.push({ rule: "bounds", message: `图层 "${id}" 位置 (${x},${y}) 超出画布左上边界` });
    }
    if ((l.type === "shape" || l.type === "image" || l.type === "video") && (x + w > W + 1 || y + h > H + 1)) {
      issues.push({ rule: "bounds", message: `图层 "${id}" 右下角 (${x + w},${y + h}) 超出画布 ${W}x${H}` });
    }
    if (y > H * 0.98) {
      issues.push({ rule: "safe-area", message: `图层 "${id}" 位于 y=${y}，已贴画布底边（安全区要求底部留白 ≥40px）` });
    }
  }

  // ── 3. 对比度：文字对其底色 ≥ 3.0（大字 WCAG AA 下限） ──
  for (const l of layers) {
    if (l.type !== "text" || typeof l.color !== "string" || !HEX_RE.test(l.color)) continue;
    const bg = findBgUnderLayer(layers, l, canvasBg);
    const ratio = contrastRatio(l.color, bg);
    if (ratio < 3) {
      issues.push({ rule: "contrast", message: `文字层 "${l.id ?? "?"}" 颜色 ${l.color} 与底色 ${bg} 对比度仅 ${ratio.toFixed(1)}:1（要求 ≥3:1），请换更亮/更暗的文字色` });
    }
  }

  // ── 4. 字号层级：最大标题字号必须明显大于最小正文字号（≥1.5 倍） ──
  const fontSizes = layers
    .filter((l) => l.type === "text" && typeof l.fontSize === "number" && l.fontSize > 0)
    .map((l) => l.fontSize!);
  if (fontSizes.length >= 3) {
    const max = Math.max(...fontSizes);
    const min = Math.min(...fontSizes);
    if (max / min < 1.5) {
      issues.push({ rule: "font-hierarchy", message: `字号层级塌陷：最大 ${max}px 与最小 ${min}px 仅差 ${(max / min).toFixed(1)} 倍（要求 ≥1.5 倍），请拉大字号的层级差距（主标题 56-96px / 小标签 22-30px）` });
    }
  }

  // ── 5. 变量引用完整性：{{var}} 必须在 variables 中声明 ──
  for (const l of layers) {
    if (l.type !== "text" || typeof l.content !== "string") continue;
    for (const m of l.content.matchAll(/\{\{([^}]+)\}\}/g)) {
      if (!variables.has(m[1])) {
        issues.push({ rule: "variable-ref", message: `文字层 "${l.id ?? "?"}" 引用了未声明的变量 {{${m[1]}}}，请在 variables 中补充声明（含 default 和中文 label）` });
      }
    }
  }

  // ── 6. 时序：start≥0、duration>0、同一时刻不超过全屏静止 ──
  for (const l of layers) {
    const id = l.id ?? "?";
    if (typeof l.start === "number" && l.start < 0) {
      issues.push({ rule: "timing", message: `图层 "${id}" start=${l.start} 小于 0` });
    }
    if (typeof l.duration === "number" && l.duration <= 0) {
      issues.push({ rule: "timing", message: `图层 "${id}" duration=${l.duration} 必须大于 0` });
    }
  }

  // ── 7. 视频槽位(2026-08-19 "假窗口"事故):含窗口语义形状却无 video 图层 → 拦截 ──
  // 背景:tpl_5e5d1f71 的 video-window 只是色块+提示文字,渲染出空框,
  // 真实视频被迫全屏混排在模板卡片之外,用户看到"完全没按模板来"。
  const WINDOW_RE = /video[-_]?window|视频窗|画面窗|主画面|视频区|播放窗/i;
  const windowShapes = layers.filter((l) => l.type === "shape" && WINDOW_RE.test(l.id ?? ""));
  const videoLayers = layers.filter((l) => l.type === "video");
  if (windowShapes.length && videoLayers.length === 0) {
    issues.push({
      rule: "video-slot",
      message: `模板含窗口形状(${windowShapes.map((s) => s.id).join("/")})但没有任何 type:"video" 图层——窗口会渲染成空框。请声明 type:"video" 变量(如 main_video)并添加 {type:"video", source:"{{main_video}}", position/size 与窗口一致} 的图层;窗口形状作为边框/衬底保留在视频层之下`,
    });
  }
  // video 变量声明了却没有视频图层引用 → 槽位空转
  const videoVarNames = new Set((raw.variables ?? []).filter((v) => v.type === "video").map((v) => v.name).filter(Boolean));
  for (const name of videoVarNames) {
    const referenced = videoLayers.some((l) => typeof (l as { source?: string }).source === "string" && ((l as { source?: string }).source as string).includes(`{{${name}}}`));
    if (!referenced) {
      issues.push({ rule: "video-slot", message: `声明了视频变量 {{${name}}} 但没有任何 video 图层引用它——槽位空转,渲染时不会被填充` });
    }
  }

  return issues;
}
