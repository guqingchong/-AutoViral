/**
 * 快照卡几何/遮罩机器预检(2026-09-11,assets 105 分钟复盘改进点 4)。
 *
 * 来源:w_20260910_1758_479 评审第 2/3 轮烧 16 分钟 LLM 判两类机器可判问题——
 *   ① 红框坐标包含关系(框出界/contain 留白导致框位移,eval-assets-2 major:
 *      "红框不指向所声称条款");
 *   ② 遮罩 alpha 覆盖率(eval-assets-3 major:"flare-mask-right.png 仅右侧约 37%
 *      渐变、边缘最大 alpha≈0.49,难以压制贯穿画面中部至右侧的光斑")。
 * 两者都是确定性几何/像素统计,挡在 LLM 评审之外。
 *
 * 契约:agent 在 assets/render-specs.json 的 cards[] 上声明(均为可选,声明即核验):
 *   kind:"snapshot" + highlights:[{left,top,width,height}]     → 坐标必须在显示区内
 *   source_px:{w,h} + wrap_px:{w,h}                            → contain 占满率 ≥0.96
 *   mask:{file,region?,min_coverage?,min_max_alpha?}           → alpha 统计达标
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DeliverableIssue } from "./quality-gate.js";

import { execFileSilent as execFileAsync } from "../utils/proc.js";

export interface HighlightDecl { left: number; top: number; width: number; height: number }
export interface MaskDecl {
  /** 遮罩 PNG 路径(相对作品目录) */
  file: string;
  /** 需压制的区域(相对画面百分比),缺省=全画面 */
  region?: { left: number; top: number; width: number; height: number };
  /** 区域内 alpha≥0.5 的像素占比下限,默认 0.6 */
  min_coverage?: number;
  /** 区域内最大 alpha 下限,默认 0.8(遮罩必须有实芯段,全渐变低 alpha 压不住) */
  min_max_alpha?: number;
}
export interface SnapshotGeometryCard {
  shot?: number;
  file?: string;
  kind?: string;
  highlights?: HighlightDecl[];
  source_px?: { w: number; h: number };
  wrap_px?: { w: number; h: number };
  mask?: MaskDecl;
}

const BOUND_EPS = 0.5;   // 百分比坐标容差
const MIN_FILL = 0.96;   // contain 占满率下限(低于则红框 % 坐标与图像内容错位)

/** ① 红框坐标包含关系:纯几何,同步可判 */
export function checkHighlightBounds(card: SnapshotGeometryCard): string[] {
  const errs: string[] = [];
  (card.highlights ?? []).forEach((h, idx) => {
    const tag = `框${idx + 1}(${h.left},${h.top},${h.width}×${h.height})`;
    if (h.left < -BOUND_EPS || h.top < -BOUND_EPS) errs.push(`${tag} 左上角出界`);
    if (h.left + h.width > 100 + BOUND_EPS || h.top + h.height > 100 + BOUND_EPS) errs.push(`${tag} 右下角出界(超出显示区)`);
    if (h.width <= 0 || h.height <= 0) errs.push(`${tag} 宽高非正数`);
  });
  return errs;
}

/** ② contain 占满率:source 与 wrap 宽高比不一致 → 留白 → 红框 % 坐标错位 */
export function checkContainFill(source: { w: number; h: number }, wrap: { w: number; h: number }): { fill: number; pass: boolean } {
  const scale = Math.min(wrap.w / source.w, wrap.h / source.h);
  const dispW = source.w * scale;
  const dispH = source.h * scale;
  const fill = (dispW * dispH) / (wrap.w * wrap.h);
  return { fill, pass: fill >= MIN_FILL };
}

async function imageSize(pngPath: string): Promise<{ w: number; h: number }> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", pngPath]);
  const st = (JSON.parse(stdout).streams ?? [])[0] ?? {};
  if (!st.width || !st.height) throw new Error(`ffprobe 无法读取 ${pngPath} 尺寸`);
  return { w: st.width, h: st.height };
}

interface AlphaStats { coverage: number; maxAlpha: number; meanAlpha: number }

/** ③ 遮罩 alpha 统计:ffmpeg crop+alphaextract 出 PGM,Node 侧做像素统计 */
export async function maskAlphaStats(maskPath: string, region?: MaskDecl["region"]): Promise<AlphaStats> {
  const { w, h } = await imageSize(maskPath);
  const r = region ?? { left: 0, top: 0, width: 100, height: 100 };
  const cw = Math.max(1, Math.round((w * r.width) / 100));
  const ch = Math.max(1, Math.round((h * r.height) / 100));
  const cx = Math.max(0, Math.round((w * r.left) / 100));
  const cy = Math.max(0, Math.round((h * r.top) / 100));
  const tmp = await mkdtemp(join(tmpdir(), "av-mask-"));
  try {
    const pgm = join(tmp, "a.pgm");
    await execFileAsync("ffmpeg", ["-y", "-v", "error", "-i", maskPath, "-vf", `crop=${cw}:${ch}:${cx}:${cy},alphaextract`, "-frames:v", "1", pgm]);
    const buf = await readFile(pgm);
    const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.toString("latin1", 0, 64));
    if (!m) throw new Error("alphaextract 输出非 PGM");
    // 数据起点用整段头部的长度(不能 indexOf("255"):尺寸含 255 时会错位)
    const headerEnd = m[0].length;
    const px = buf.subarray(headerEnd);
    let sum = 0, max = 0, opaque = 0;
    for (const v of px) {
      sum += v;
      if (v > max) max = v;
      if (v >= 128) opaque++;
    }
    const n = px.length || 1;
    return { coverage: opaque / n, maxAlpha: max / 255, meanAlpha: sum / n / 255 };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** assets 门禁入口:读 render-specs.json,逐卡核验声明的几何/遮罩契约 */
export async function assertSnapshotGeometry(workDir: string): Promise<DeliverableIssue[]> {
  const issues: DeliverableIssue[] = [];
  const specsPath = join(workDir, "assets", "render-specs.json");
  if (!existsSync(specsPath)) return issues; // 无台账由数值一致性/评审兜底
  let cards: SnapshotGeometryCard[] = [];
  try {
    cards = (JSON.parse(readFileSync(specsPath, "utf-8")) as { cards?: SnapshotGeometryCard[] }).cards ?? [];
  } catch { return issues; } // JSON 损坏由 assertValueConsistency 拦

  for (const card of cards) {
    const tag = `镜${card.shot ?? "?"} ${card.file ?? "?"}`;
    // ① 红框坐标
    for (const e of checkHighlightBounds(card)) {
      issues.push({ key: "highlight_out_of_bounds", detail: `${tag} 红框${e}——红框 % 坐标必须落在显示区 [0,100] 内,出界即框不住所声称内容` });
    }
    // ② contain 占满率
    if (card.source_px && card.wrap_px) {
      const { fill, pass } = checkContainFill(card.source_px, card.wrap_px);
      if (!pass) {
        issues.push({ key: "snapshot_letterbox", detail: `${tag} 显示区 contain 占满率 ${fill.toFixed(3)} < ${MIN_FILL}——源图 ${card.source_px.w}×${card.source_px.h} 与显示区 ${card.wrap_px.w}×${card.wrap_px.h} 宽高比不一致,留白导致红框 % 坐标与图像内容错位;请按显示区宽高比预裁源图` });
      }
    }
    // ③ 遮罩 alpha 覆盖率
    if (card.mask?.file) {
      const maskPath = resolve(workDir, card.mask.file);
      if (!existsSync(maskPath)) {
        issues.push({ key: "mask_missing", detail: `${tag} 声明的遮罩 ${card.mask.file} 不存在——遮罩必须实际产出并接受机器核验` });
      } else {
        try {
          const st = await maskAlphaStats(maskPath, card.mask.region);
          const needCov = card.mask.min_coverage ?? 0.6;
          const needMax = card.mask.min_max_alpha ?? 0.8;
          if (st.coverage < needCov || st.maxAlpha < needMax) {
            issues.push({
              key: "mask_coverage_low",
              detail: `${tag} 遮罩覆盖不足:区域内 alpha≥0.5 像素占比 ${(st.coverage * 100).toFixed(0)}%(要求≥${needCov * 100}%),最大 alpha ${st.maxAlpha.toFixed(2)}(要求≥${needMax})——渐变过浅/范围过窄压不住目标瑕疵,请加宽遮罩或提高不透明度(2026-09-10 镜38 眩光遮罩 major 同类)`,
            });
          }
        } catch (err) {
          issues.push({ key: "mask_check_failed", detail: `${tag} 遮罩机器核验失败:${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }
  return issues;
}
