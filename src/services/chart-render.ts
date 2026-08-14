/**
 * A1 数据图表素材渲染(2026-08-14 素材来源扩展)。
 *
 * ECharts option JSON → 无头浏览器渲染高清图表 PNG。
 * 解决"AI 生图画图表数字必错"的硬伤:数据驱动的图表由代码生成,
 * 数字 100% 准确、风格统一可控、可反复编辑。
 *
 * 用法:策划/素材阶段 LLM 只输出 ECharts option(数据+系列配置),
 * 主题(配色/字体/底色)由本服务统一注入,保证全账号视觉一致性。
 */

import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { renderHtmlToPng } from "./html-render.js";
import { dataDir } from "../config.js";

const require = createRequire(import.meta.url);

let echartsJsCache: string | null = null;
async function loadEchartsJs(): Promise<string> {
  if (echartsJsCache) return echartsJsCache;
  const echartsPath = require.resolve("echarts/dist/echarts.min.js");
  echartsJsCache = await readFile(echartsPath, "utf-8");
  return echartsJsCache;
}

/** 图表主题:统一账号视觉,LLM 不许自由发挥配色 */
export interface ChartTheme {
  key: string;
  label: string;
  background: string;
  palette: string[];
  textColor: string;
  subTextColor: string;
  axisLineColor: string;
  splitLineColor: string;
}

export const CHART_THEMES: ChartTheme[] = [
  {
    key: "finance_dark",
    label: "财经深蓝",
    background: "#0f1b2d",
    palette: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"],
    textColor: "#f1f5f9",
    subTextColor: "#94a3b8",
    axisLineColor: "#334155",
    splitLineColor: "#1e293b",
  },
  {
    key: "warm_gold",
    label: "暖黑金",
    background: "#161311",
    palette: ["#d4af37", "#e8c56b", "#b8860b", "#f5deb3", "#cd853f", "#8b6914"],
    textColor: "#f5efe0",
    subTextColor: "#a89968",
    axisLineColor: "#3d3629",
    splitLineColor: "#26211a",
  },
  {
    key: "ink_green",
    label: "墨绿知识",
    background: "#0d1f1a",
    palette: ["#3fd68f", "#2dd4bf", "#84cc16", "#facc15", "#fb923c", "#38bdf8"],
    textColor: "#e8f5ee",
    subTextColor: "#8fbc9f",
    axisLineColor: "#1e3a2f",
    splitLineColor: "#14291f",
  },
  {
    key: "minimal_light",
    label: "米白简约",
    background: "#fafaf7",
    palette: ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"],
    textColor: "#1c1917",
    subTextColor: "#78716c",
    axisLineColor: "#d6d3d1",
    splitLineColor: "#e7e5e4",
  },
];

export function getChartTheme(key?: string): ChartTheme {
  return CHART_THEMES.find((t) => t.key === key) ?? CHART_THEMES[0];
}

export interface ChartRenderInput {
  /** ECharts option(只需 series/xAxis/yAxis 等数据配置,主题自动注入) */
  option: Record<string, unknown>;
  theme?: string;
  width?: number;
  height?: number;
  /** 高清倍数,默认 2(1080 宽输出 2160 像素) */
  scale?: number;
  /** 图表大标题(可选,渲染在图表上方) */
  title?: string;
  /** 数据来源署名(可选,渲染在左下角,增强可信度) */
  source?: string;
}

function buildChartHtml(input: ChartRenderInput, theme: ChartTheme, echartsJs: string): string {
  const width = input.width ?? 1080;
  const height = input.height ?? 1080;
  const hasHeader = !!(input.title || input.source);
  const chartTop = input.title ? 110 : 20;
  const chartBottom = input.source ? 70 : 20;
  const baseOption = {
    backgroundColor: "transparent",
    color: theme.palette,
    animation: false,
    textStyle: { color: theme.textColor, fontFamily: "Microsoft YaHei, PingFang SC, sans-serif" },
    title: input.option.title ?? undefined,
    legend: { textStyle: { color: theme.subTextColor } },
    grid: { left: 90, right: 50, top: 70, bottom: 70, containLabel: false },
  };
  const merged = JSON.stringify({ ...baseOption, ...input.option });
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:${theme.background};overflow:hidden}
  #chart{position:absolute;left:20px;top:${chartTop}px;width:${width - 40}px;height:${height - chartTop - chartBottom}px}
  .c-title{position:absolute;left:36px;top:30px;font:700 44px 'Microsoft YaHei',sans-serif;color:${theme.textColor}}
  .c-source{position:absolute;left:36px;bottom:22px;font:400 24px 'Microsoft YaHei',sans-serif;color:${theme.subTextColor}}
</style></head><body>
${hasHeader && input.title ? `<div class="c-title">${escapeHtml(input.title)}</div>` : ""}
<div id="chart"></div>
${input.source ? `<div class="c-source">数据来源:${escapeHtml(input.source)}</div>` : ""}
<script>${echartsJs}</script>
<script>
  try {
    const chart = echarts.init(document.getElementById('chart'), null, {renderer:'canvas'});
    const option = ${merged};
    // 轴线/分割线颜色随主题(用户 option 显式设置的不覆盖)
    option.xAxis = normalizeAxis(option.xAxis);
    option.yAxis = normalizeAxis(option.yAxis);
    function normalizeAxis(ax){
      if(!ax) return ax;
      const fix = (a)=>Object.assign({
        axisLine:{lineStyle:{color:'${theme.axisLineColor}',width:2}},
        axisLabel:{color:'${theme.subTextColor}',fontSize:26},
        splitLine:{lineStyle:{color:'${theme.splitLineColor}'}},
        nameTextStyle:{color:'${theme.subTextColor}'},
      }, a);
      return Array.isArray(ax) ? ax.map(fix) : fix(ax);
    }
    if(!option.textStyle) option.textStyle = {};
    option.textStyle.color = option.textStyle.color || '${theme.textColor}';

    // 精品化默认(2026-08-14 质感提升):渐变柱体/加大数值标签/折线面积渐变。
    // 原则:只补默认值,调用方 option 显式设置的项一律不覆盖。
    function __rgb(hex){
      if(typeof hex !== 'string' || hex[0] !== '#') return null;
      let h = hex.slice(1);
      if(h.length === 3) h = h.split('').map(c=>c+c).join('');
      if(h.length !== 6) return null;
      return [parseInt(h.substr(0,2),16), parseInt(h.substr(2,2),16), parseInt(h.substr(4,2),16)];
    }
    function __shade(hex, f){ const c = __rgb(hex); return c ? 'rgb('+c.map(v=>Math.round(v*f)).join(',')+')' : hex; }
    function __alpha(hex, a){ const c = __rgb(hex); return c ? 'rgba('+c.join(',')+','+a+')' : hex; }
    (function beautify(){
      const series = option.series ? (Array.isArray(option.series) ? option.series : [option.series]) : [];
      series.forEach(function(s, i){
        const base = (option.color && option.color.length) ? option.color[i % option.color.length] : '#3b82f6';
        if (s.type === 'bar') {
          s.itemStyle = s.itemStyle || {};
          if (!s.itemStyle.color) {
            s.itemStyle.color = new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              {offset: 0, color: base}, {offset: 1, color: __shade(base, 0.30)}
            ]);
          }
          if (!s.itemStyle.borderRadius) s.itemStyle.borderRadius = [12, 12, 0, 0];
          s.label = Object.assign({show: true, position: 'top', fontSize: 34, fontWeight: 700, color: '${theme.textColor}'}, s.label);
        }
        if (s.type === 'line') {
          if (s.smooth === undefined) s.smooth = true;
          s.lineStyle = Object.assign({width: 6}, s.lineStyle);
          if (!s.areaStyle) {
            s.areaStyle = {color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              {offset: 0, color: __alpha(base, 0.35)}, {offset: 1, color: __alpha(base, 0.02)}
            ])};
          }
          if (!s.symbolSize) s.symbolSize = 12;
          s.label = Object.assign({show: true, position: 'top', fontSize: 30, fontWeight: 700, color: '${theme.textColor}'}, s.label);
        }
        if (s.type === 'pie') {
          s.label = Object.assign({fontSize: 26, color: '${theme.textColor}'}, s.label);
        }
      });
    })();

    chart.setOption(option);
    window.__renderReady = true;
  } catch(e) {
    document.body.innerHTML = '<div style="color:#f66;font:28px sans-serif;padding:40px">图表渲染失败: '+String(e).replace(/</g,'&lt;')+'</div>';
    window.__renderReady = true;
  }
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 渲染图表 PNG,返回文件路径 */
export async function renderChart(input: ChartRenderInput): Promise<{ path: string; url: string }> {
  if (!input.option || typeof input.option !== "object" || !input.option.series) {
    throw new Error("ECharts option 必须包含 series(数据系列)");
  }
  const theme = getChartTheme(input.theme);
  const echartsJs = await loadEchartsJs();
  const html = buildChartHtml(input, theme, echartsJs);
  const width = input.width ?? 1080;
  const height = input.height ?? 1080;
  const outDir = join(dataDir, "shared-assets", "charts");
  await mkdir(outDir, { recursive: true });
  const name = `chart-${Date.now()}.png`;
  const outPath = join(outDir, name);
  await renderHtmlToPng(html, outPath, {
    width, height,
    scale: input.scale ?? 2,
    waitForReadyFlag: true,
  });
  const url = `/api/shared-assets/charts/${name}`;
  // C5 素材沉淀:图表自动登记进资产库
  try {
    const { createAsset } = await import("../db/assets-repo.js");
    createAsset({
      name: input.title ?? `图表 ${name}`,
      file_path: outPath,
      category: "general",
      type: "image",
      tags: [input.title, input.source, theme.key, "图表"].filter((t): t is string => !!t),
      source: "self-generated",
      license: "unknown",
      compliance_status: "passed",
      metadata: { url, theme: theme.key, assetKind: "chart" },
      usage_count: 0,
    });
  } catch { /* 登记失败不阻断 */ }
  return { path: outPath, url };
}
