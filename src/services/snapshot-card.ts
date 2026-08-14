/**
 * A2 政策文件/网页快照卡(2026-08-14 素材来源扩展)。
 *
 * 讲政策/新闻时直接展示原文截图 + 高亮标注——权威感是 AI 画面给不了的。
 * 流程:URL 截图(或本地图片)→ 卡片化包装(圆角阴影+高亮框+来源署名)→ PNG。
 *
 * 高亮框用百分比坐标(相对截图区域),LLM 目测位置即可,无需精确像素。
 */

import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { renderHtmlToPng } from "./html-render.js";
import { dataDir } from "../config.js";

/** 高亮标注框(百分比坐标,相对截图区域) */
export interface HighlightBox {
  /** 0-100,相对截图宽度 */
  left: number;
  /** 0-100,相对截图高度 */
  top: number;
  width: number;
  height: number;
  /** 框颜色,默认金红 */
  color?: string;
  /** 框旁标注文字(可选) */
  label?: string;
}

export interface SnapshotCardInput {
  /** 二选一:网页 URL(自动截图) */
  url?: string;
  /** 二选一:本地图片路径(已截好的图) */
  imagePath?: string;
  /** 高亮标注框列表 */
  highlights?: HighlightBox[];
  /** 卡片标题(如政策名称) */
  title?: string;
  /** 来源署名(如"财政部官网") */
  source?: string;
  /** 卡片宽,默认 1080 */
  width?: number;
  /** 卡片高,默认 1350(3:4) */
  height?: number;
  /** 底色风格:dark(深蓝) | light(米白),默认 dark */
  style?: "dark" | "light";
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** URL → 截图 data URI(独立 browser,不用渲染单例——截外部网页要完整网络栈) */
async function screenshotUrl(url: string): Promise<{ dataUri: string; w: number; h: number }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => {
      // networkidle 超时时降级 domcontentloaded 后硬等
      await page.waitForTimeout(5000);
    });
    await page.waitForTimeout(2000); // 字体/图片稳定
    const buf = await page.screenshot({ type: "png" });
    return { dataUri: `data:image/png;base64,${buf.toString("base64")}`, w: 1280, h: 900 };
  } finally {
    await browser.close();
  }
}

async function imageToDataUri(imagePath: string): Promise<string> {
  const mime = MIME[extname(imagePath).toLowerCase()] ?? "image/png";
  const buf = await readFile(imagePath);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildCardHtml(input: SnapshotCardInput, imgDataUri: string): string {
  const W = input.width ?? 1080;
  const H = input.height ?? 1350;
  const dark = input.style !== "light";
  const bg = dark ? "#111827" : "#f5f2ea";
  const fg = dark ? "#f3f4f6" : "#1f2937";
  const sub = dark ? "#9ca3af" : "#6b7280";
  const title = input.title ? esc(input.title) : "";
  const source = input.source ? esc(input.source) : "";
  const highlights = (input.highlights ?? []).map((h) => {
    const color = h.color ?? "#e53e3e";
    const label = h.label ? `<span class="hl-label" style="background:${color}">${esc(h.label)}</span>` : "";
    return `<div class="hl" style="left:${h.left}%;top:${h.top}%;width:${h.width}%;height:${h.height}%;border-color:${color}">${label}</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:${bg};overflow:hidden;font-family:'Microsoft YaHei','PingFang SC',sans-serif}
  .card{position:absolute;inset:0;display:flex;flex-direction:column;padding:48px 44px;box-sizing:border-box}
  .c-title{font-size:46px;font-weight:700;color:${fg};line-height:1.3;margin-bottom:28px}
  .shot-wrap{position:relative;flex:1;min-height:0;border-radius:18px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,${dark ? "0.55" : "0.18"});background:#fff}
  .shot-wrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fff}
  .hl{position:absolute;border:5px solid;border-radius:8px;box-shadow:0 0 0 3px rgba(255,255,255,0.35);box-sizing:border-box}
  .hl-label{position:absolute;top:-44px;left:-5px;font-size:28px;color:#fff;padding:6px 14px;border-radius:8px;white-space:nowrap}
  .c-footer{display:flex;align-items:center;gap:16px;margin-top:26px;color:${sub};font-size:26px}
  .c-dot{width:10px;height:10px;border-radius:50%;background:#e53e3e;flex-shrink:0}
</style></head><body>
<div class="card">
  ${title ? `<div class="c-title">${title}</div>` : ""}
  <div class="shot-wrap"><img src="${imgDataUri}" />${highlights}</div>
  ${source ? `<div class="c-footer"><span class="c-dot"></span><span>来源:${source}</span></div>` : ""}
</div>
</body></html>`;
}

/** 生成快照卡 PNG,返回文件路径与可访问 URL */
export async function renderSnapshotCard(input: SnapshotCardInput): Promise<{ path: string; url: string }> {
  if (!input.url && !input.imagePath) throw new Error("url 或 imagePath 必须提供一个");
  const imgDataUri = input.url ? (await screenshotUrl(input.url)).dataUri : await imageToDataUri(input.imagePath!);
  const html = buildCardHtml(input, imgDataUri);
  const outDir = join(dataDir, "shared-assets", "snapshots");
  await mkdir(outDir, { recursive: true });
  const name = `snapshot-${Date.now()}.png`;
  const outPath = join(outDir, name);
  await renderHtmlToPng(html, outPath, {
    width: input.width ?? 1080,
    height: input.height ?? 1350,
    scale: 2,
  });
  const url = `/api/shared-assets/snapshots/${name}`;
  // C5 素材沉淀:快照卡自动登记进资产库
  try {
    const { createAsset } = await import("../db/assets-repo.js");
    createAsset({
      name: input.title ?? `快照卡 ${name}`,
      file_path: outPath,
      category: "general",
      type: "image",
      tags: [input.title, input.source, "快照卡"].filter((t): t is string => !!t),
      source: "self-generated",
      license: "unknown",
      compliance_status: "passed",
      metadata: { url, assetKind: "snapshot" },
      usage_count: 0,
    });
  } catch { /* 登记失败不阻断 */ }
  return { path: outPath, url };
}
