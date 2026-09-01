/**
 * FFmpeg drawtext/drawbox 公共工具。
 *
 * 解决三类已知缺陷：
 * 1. CSS 风格颜色（rgba()/rgb()/#hex）直接进入 FFmpeg filter 会撑爆 filter
 *    解析器（rgba() 的逗号被当作滤镜参数分隔符），需要统一规范化为 0xRRGGBB[AA]。
 * 2. Windows 上 FreeType 无法加载含非 ASCII 字符的字体路径（例如中文用户名），
 *    渲染前需把字体复制到纯 ASCII 目录。
 * 3. drawtext 的 text 参数有多层转义要求（filter 层 + text expansion 层），
 *    且不支持自动换行，需要在应用层拆行。
 */

import { copyFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";

// ── 字体管理 ─────────────────────────────────────────────────────────────────

const FONT_TARGET_DIR =
  process.platform === "win32" ? "C:\\ProgramData\\AutoViral\\fonts" : "/usr/local/share/autoviral/fonts";

export type FontWeight = "regular" | "bold" | "black";

const FONT_FILES: Record<FontWeight, string> = {
  regular: "NotoSansCJKsc-Regular.otf",
  bold: "NotoSansCJKsc-Bold.otf",
  black: "NotoSansCJKsc-Black.otf",
};

const SYSTEM_FALLBACK_FONTS: Record<FontWeight, string> =
  process.platform === "win32"
    ? {
        regular: "C:\\Windows\\Fonts\\msyh.ttc",
        bold: "C:\\Windows\\Fonts\\msyhbd.ttc",
        black: "C:\\Windows\\Fonts\\msyhbd.ttc",
      }
    : {
        regular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        bold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        black: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
      };

let cachedFontPaths: Record<FontWeight, string> | undefined;

/**
 * 确保 NotoSans 字体在纯 ASCII 路径下可用并返回字体路径表。
 * 复制失败（权限不足等）时回退到系统字体。结果做模块级缓存。
 */
export async function resolveFontPaths(): Promise<Record<FontWeight, string>> {
  if (cachedFontPaths) return cachedFontPaths;
  try {
    const srcDir = join(dataDir, "fonts");
    await mkdir(FONT_TARGET_DIR, { recursive: true });
    const result = {} as Record<FontWeight, string>;
    for (const [weight, file] of Object.entries(FONT_FILES) as [FontWeight, string][]) {
      const target = join(FONT_TARGET_DIR, file);
      try {
        await access(target);
      } catch {
        await copyFile(join(srcDir, file), target);
      }
      result[weight] = target;
    }
    cachedFontPaths = result;
  } catch {
    cachedFontPaths = { ...SYSTEM_FALLBACK_FONTS };
  }
  return cachedFontPaths;
}

/** 同步获取字体路径（resolveFontPaths 已预热后使用；未预热时按目标路径假定） */
export function getFontPath(weight: FontWeight = "bold"): string {
  if (cachedFontPaths) return cachedFontPaths[weight];
  return join(FONT_TARGET_DIR, FONT_FILES[weight]);
}

/** 文件路径 → FFmpeg filter 语法安全形式（正斜杠 + 盘符冒号转义） */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

// ── 颜色规范化 ───────────────────────────────────────────────────────────────

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function parseHexColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = color.trim();
  let hex = "";
  if (m.startsWith("#")) hex = m.slice(1);
  else if (m.startsWith("0x") || m.startsWith("0X")) hex = m.slice(2);
  else return null;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 6) hex += "ff";
  if (hex.length !== 8 || /[^0-9a-fA-F]/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: parseInt(hex.slice(6, 8), 16) / 255,
  };
}

function parseRgbFunc(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = color.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (!m) return null;
  return {
    r: parseFloat(m[1]),
    g: parseFloat(m[2]),
    b: parseFloat(m[3]),
    a: m[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(m[4]))) : 1,
  };
}

/**
 * 把 CSS 风格颜色规范化为 FFmpeg 滤镜安全颜色。
 *
 * - `#RRGGBB` / `#RRGGBBAA` / `0x...` → `0xRRGGBB`（或带 alpha 时按 bgColor 预混合）
 * - `rgb()/rgba()` → 同上（rgba 的逗号会破坏 FFmpeg filter 解析，必须转换）
 * - 半透明颜色：提供 bgColor 时与其做 alpha 预混合输出实色（drawbox 在 yuv420p
 *   画面上不支持真正的半透明混合）；否则输出 `0xRRGGBBAA`。
 * - 颜色名（white/black/...）原样返回（FFmpeg 原生支持）。
 */
export function normalizeColorForFfmpeg(color: string | undefined, bgColor?: string): string {
  if (!color) return "0xFFFFFF";
  const trimmed = color.trim();
  const parsed = parseHexColor(trimmed) ?? parseRgbFunc(trimmed);
  if (!parsed) return trimmed; // 颜色名等，原样返回
  if (parsed.a >= 0.999) {
    return `0x${hex2(parsed.r)}${hex2(parsed.g)}${hex2(parsed.b)}`;
  }
  const bg = bgColor ? (parseHexColor(bgColor) ?? parseRgbFunc(bgColor)) : null;
  if (bg) {
    const a = parsed.a;
    return `0x${hex2(parsed.r * a + bg.r * (1 - a))}${hex2(parsed.g * a + bg.g * (1 - a))}${hex2(parsed.b * a + bg.b * (1 - a))}`;
  }
  const aHex = hex2(parsed.a * 255);
  return `0x${hex2(parsed.r)}${hex2(parsed.g)}${hex2(parsed.b)}${aHex}`;
}

// ── drawtext 文本处理 ────────────────────────────────────────────────────────

/**
 * drawtext text 参数转义。需要同时满足三层解析：
 * 1. filter 图解析层（\ ' : , ; [ ]）
 * 2. drawtext 参数解析层（: 分隔参数）
 * 3. drawtext text expansion 层（% 引导表达式 —— 必须转义为 \\%，
 *    filter 层消耗一个反斜杠后 expansion 层才能看到 \%）
 *
 * 实测结论（2026-07-17，无 shell argv 传递）：
 * - %  → \\%（单层 \% 会触发 "Stray %" 警告且文本丢失）
 * - :  → \:（单层即可；双层会让冒号变成真的参数分隔符）
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\") // \ → \\\\（filter 层 + drawtext 层各消耗一层）
    .replace(/'/g, "'\\''") // ' → '\''（包在单引号内的标准转义）
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\\\%")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** 估算字符显示宽度（以全角为 1 个单位） */
function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  // CJK 统一表意文字、扩展区、中文标点、全角字符
  if (cp >= 0x2e80) return 1;
  return 0.55;
}

/**
 * 按渲染宽度把文本拆成多行（drawtext 不支持自动换行）。
 * @param maxWidth 可用像素宽度；<=0 或 undefined 表示不拆行
 */
export function wrapTextLines(text: string, fontSize: number, maxWidth?: number): string[] {
  if (!text) return [];
  const hardLines = text.split(/\r?\n/);
  if (!maxWidth || maxWidth <= 0) return hardLines;
  const maxUnits = Math.max(maxWidth / fontSize, 2);
  // 避头:这些标点不得出现在行首(否则边界处切出标点孤行),宁可让上一行略微超宽
  const noLineStart = new Set("，。、；：？！…—·』」》）〕〉”’,.;:!?)]}\"'");
  const lines: string[] = [];
  for (const raw of hardLines) {
    let cur = "";
    let units = 0;
    for (const ch of raw) {
      const w = charUnits(ch);
      if (units + w > maxUnits && cur.length > 0 && !noLineStart.has(ch)) {
        lines.push(cur);
        cur = ch;
        units = w;
      } else {
        cur += ch;
        units += w;
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
}

/** drawtext 多行排版时的行高（像素） */
export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.4);
}
