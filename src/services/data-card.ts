/**
 * B4 数据卡素材(2026-08-14 素材来源扩展)。
 *
 * 结构化数据 → 图表 PNG 的便捷入口:调用方(通常是具备 MCP 检索能力的
 * Agent,如 Claude Code 通过 hermes-kp 搜知识中台)负责取数和抽数,
 * 本服务负责把 {label, value} 列表确定性地变成图表——LLM 不需要手写
 * ECharts option,降低出错面。
 *
 * 与 chart-render 的关系:data-card 是"简单数据→图表"的便捷封装,
 * 复杂图表(双轴/堆叠/雷达)仍可直接走 /api/assets/chart 传完整 option。
 */

import { renderChart } from "./chart-render.js";

export interface DataCardInput {
  /** 数据点列表(必需) */
  data: Array<{ label: string; value: number }>;
  /** 图表类型:auto(默认) | bar | line | pie */
  chartType?: "auto" | "bar" | "line" | "pie";
  /** 图表大标题 */
  title?: string;
  /** 数据来源署名 */
  source?: string;
  /** 单位(如"万亿元"),显示在轴/标签上 */
  unit?: string;
  theme?: string;
  width?: number;
  height?: number;
}

/** 标签像时间序列(年份/年月/日期)→ 折线图更合适 */
function looksTimeSeries(labels: string[]): boolean {
  return labels.every((l) => /^(\d{4}([年\-/\.]\d{1,2}([月\-/\.]\d{1,2}日?)?)?|Q[1-4]|\d{1,2}月)$/.test(l.trim()));
}

function pickChartType(input: DataCardInput): "bar" | "line" | "pie" {
  if (input.chartType && input.chartType !== "auto") return input.chartType;
  const labels = input.data.map((d) => d.label);
  if (looksTimeSeries(labels)) return "line";
  return "bar";
}

export async function renderDataCard(input: DataCardInput): Promise<{ path: string; url: string }> {
  if (!Array.isArray(input.data) || input.data.length === 0) {
    throw new Error("data 必须是非空数组:[{label, value}, ...]");
  }
  for (const d of input.data) {
    if (typeof d.label !== "string" || typeof d.value !== "number" || Number.isNaN(d.value)) {
      throw new Error("data 元素必须是 {label: string, value: number}");
    }
  }
  const type = pickChartType(input);
  const labels = input.data.map((d) => d.label);
  const values = input.data.map((d) => d.value);
  const unit = input.unit ?? "";

  let option: Record<string, unknown>;
  if (type === "pie") {
    // 单位是 % 时数值即占比,不再重复显示 d%
    const pieLabel = unit === "%" ? `{b}\n{c}%` : `{b}\n{c}${unit} ({d}%)`;
    option = {
      series: [{
        type: "pie",
        radius: ["35%", "62%"],
        center: ["50%", "52%"],
        data: input.data.map((d) => ({ name: d.label, value: d.value })),
        label: { show: true, formatter: pieLabel, fontSize: 26, fontWeight: 700 },
        itemStyle: { borderRadius: 10, borderWidth: 3, borderColor: "rgba(0,0,0,0.15)" },
      }],
      legend: { bottom: 10, textStyle: { fontSize: 22 } },
    };
  } else if (type === "line") {
    option = {
      xAxis: { type: "category", data: labels, boundaryGap: false },
      yAxis: { type: "value", name: unit },
      series: [{
        type: "line",
        data: values,
        smooth: true,
        symbolSize: 12,
        lineStyle: { width: 5 },
        areaStyle: { opacity: 0.15 },
        label: { show: true, position: "top", fontSize: 30, fontWeight: 700, formatter: `{c}${unit}` },
      }],
    };
  } else {
    option = {
      xAxis: { type: "category", data: labels, axisLabel: { fontSize: 26, interval: 0, rotate: labels.some((l) => l.length > 4) ? 20 : 0 } },
      yAxis: { type: "value", name: unit },
      series: [{
        type: "bar",
        data: values,
        barMaxWidth: 140,
        label: { show: true, position: "top", fontSize: 34, fontWeight: 700, formatter: `{c}${unit}` },
        itemStyle: { borderRadius: [12, 12, 0, 0] },
      }],
    };
  }

  return renderChart({
    option,
    theme: input.theme,
    width: input.width,
    height: input.height,
    title: input.title,
    source: input.source,
  });
}
