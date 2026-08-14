/**
 * 5 个精品模板种子(2026-08-14,按设计规范 token 手工打造)。
 * 运行:node scripts/seed-premium-templates.mjs
 * 已存在的(按 id)跳过,幂等可重跑。
 */
import { createTemplate, getTemplate } from "../dist/db/templates-repo.js";
import { scoreTemplate } from "../dist/services/template-score.js";

const D = 8; // 单幕时长(素材驱动时长下仅作默认)

/** 财经数据播报·深蓝 */
const tplFinance = {
  id: "tpl_premium_finance",
  name: "财经数据播报·深蓝巨数",
  content_form: "data_show",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0f1b2d" },
  variables: [
    { name: "title", type: "text", label: "标题", default: "2025年专项债发行规模" },
    { name: "stat", type: "text", label: "核心数字", default: "4.4万亿" },
    { name: "stat_label", type: "text", label: "数字说明", default: "新增专项债券发行额度" },
    { name: "summary", type: "text", label: "解读正文", default: "规模再创新高,投向更聚焦市政与产业园区,稳增长信号明确。" },
    { name: "source", type: "text", label: "数据来源", default: "数据来源:财政部" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#0f1b2d", start: 0, duration: D, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "accent_bar", type: "shape", shape: "rect", fill: "#3b82f6", start: 0.3, duration: D - 0.3, position: { x: 70, y: 318 }, size: { width: 64, height: 10 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "title", type: "text", content: "{{title}}", fontSize: 60, color: "#f1f5f9", align: "left", start: 0.3, duration: D - 0.3, position: { x: 70, y: 350 }, size: { width: 940, height: 90 }, animations: [{ type: "slidein", duration: 0.4, direction: "left" }] },
    { id: "stat", type: "text", content: "{{stat}}", fontSize: 120, color: "#3b82f6", align: "left", start: 0.6, duration: D - 0.6, position: { x: 70, y: 620 }, size: { width: 940, height: 170 }, animations: [{ type: "slidein", duration: 0.5, direction: "bottom" }] },
    { id: "stat_label", type: "text", content: "{{stat_label}}", fontSize: 34, color: "#94a3b8", align: "left", start: 0.8, duration: D - 0.8, position: { x: 70, y: 810 }, size: { width: 940, height: 50 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "divider", type: "shape", shape: "rect", fill: "#1e3a5f", start: 1.0, duration: D - 1.0, position: { x: 70, y: 960 }, size: { width: 940, height: 3 } },
    { id: "summary", type: "text", content: "{{summary}}", fontSize: 34, color: "#cbd5e1", align: "left", start: 1.1, duration: D - 1.1, position: { x: 70, y: 1010 }, size: { width: 940, height: 200 }, animations: [{ type: "fadein", duration: 0.5 }] },
    { id: "source", type: "text", content: "{{source}}", fontSize: 26, color: "#64748b", align: "left", start: 1.3, duration: D - 1.3, position: { x: 70, y: 1330 }, size: { width: 940, height: 40 } },
  ],
  audio: [],
  transitions: [],
  status: "approved",
  kind: "video",
};

/** 政策解读·朱红文件 */
const tplPolicy = {
  id: "tpl_premium_policy",
  name: "政策解读·朱红文件卡",
  content_form: "industry",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#faf6f0" },
  variables: [
    { name: "title", type: "text", label: "文件标题", default: "关于优化地方政府专项债券管理的意见" },
    { name: "issuer", type: "text", label: "发文机关", default: "国务院办公厅" },
    { name: "point_1", type: "text", label: "要点一", default: "扩大专项债投向领域,实行负面清单管理" },
    { name: "point_2", type: "text", label: "要点二", default: "允许用于收购存量商品房作保障房" },
    { name: "point_3", type: "text", label: "要点三", default: "加快发行使用节奏,尽早形成实物工作量" },
    { name: "source", type: "text", label: "来源", default: "来源:中国政府网" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#faf6f0", start: 0, duration: D, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "top_bar1", type: "shape", shape: "rect", fill: "#c8102e", start: 0, duration: D, position: { x: 0, y: 260 }, size: { width: 1080, height: 8 } },
    { id: "top_bar2", type: "shape", shape: "rect", fill: "#c8102e", start: 0, duration: D, position: { x: 0, y: 276 }, size: { width: 1080, height: 3 } },
    { id: "kicker", type: "text", content: "政策解读", fontSize: 34, color: "#c8102e", align: "left", start: 0.3, duration: D - 0.3, position: { x: 70, y: 320 }, size: { width: 300, height: 50 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "title", type: "text", content: "{{title}}", fontSize: 54, color: "#1c1917", align: "left", start: 0.4, duration: D - 0.4, position: { x: 70, y: 390 }, size: { width: 940, height: 160 }, animations: [{ type: "slidein", duration: 0.4, direction: "left" }] },
    { id: "issuer", type: "text", content: "{{issuer}}", fontSize: 30, color: "#78716c", align: "left", start: 0.6, duration: D - 0.6, position: { x: 70, y: 560 }, size: { width: 940, height: 44 } },
    { id: "card", type: "shape", shape: "rect", fill: "#ffffff", start: 0.7, duration: D - 0.7, position: { x: 70, y: 680 }, size: { width: 940, height: 560 }, animations: [{ type: "slidein", duration: 0.5, direction: "bottom" }] },
    { id: "card_edge", type: "shape", shape: "rect", fill: "#c8102e", start: 0.9, duration: D - 0.9, position: { x: 70, y: 680 }, size: { width: 10, height: 560 } },
    { id: "point_1", type: "text", content: "① {{point_1}}", fontSize: 34, color: "#1c1917", align: "left", start: 1.0, duration: D - 1.0, position: { x: 120, y: 740 }, size: { width: 840, height: 120 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "point_2", type: "text", content: "② {{point_2}}", fontSize: 34, color: "#1c1917", align: "left", start: 1.3, duration: D - 1.3, position: { x: 120, y: 900 }, size: { width: 840, height: 120 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "point_3", type: "text", content: "③ {{point_3}}", fontSize: 34, color: "#1c1917", align: "left", start: 1.6, duration: D - 1.6, position: { x: 120, y: 1060 }, size: { width: 840, height: 120 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "source", type: "text", content: "{{source}}", fontSize: 26, color: "#78716c", align: "left", start: 1.8, duration: D - 1.8, position: { x: 70, y: 1330 }, size: { width: 940, height: 40 } },
  ],
  audio: [],
  transitions: [],
  status: "approved",
  kind: "video",
};

/** 知识科普·墨绿杂志 */
const tplKnowledge = {
  id: "tpl_premium_knowledge",
  name: "知识科普·墨绿三卡递进",
  content_form: "knowledge",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0d1f1a" },
  variables: [
    { name: "title", type: "text", label: "主题", default: "专项债如何形成实物工作量" },
    { name: "card1_title", type: "text", label: "卡片一标题", default: "资金下达" },
    { name: "card1_body", type: "text", label: "卡片一正文", default: "额度分配到省,清单管理到项目" },
    { name: "card2_title", type: "text", label: "卡片二标题", default: "项目开工" },
    { name: "card2_body", type: "text", label: "卡片二正文", default: "资金拨付进度与开工率双考核" },
    { name: "card3_title", type: "text", label: "卡片三标题", default: "形成投资" },
    { name: "card3_body", type: "text", label: "卡片三正文", default: "当年形成实物工作量,计入有效投资" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#0d1f1a", start: 0, duration: D, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "serial", type: "text", content: "01", fontSize: 140, color: "#16352b", align: "left", start: 0.2, duration: D - 0.2, position: { x: 830, y: 280 }, size: { width: 200, height: 170 } },
    { id: "title", type: "text", content: "{{title}}", fontSize: 58, color: "#e8f5ee", align: "left", start: 0.3, duration: D - 0.3, position: { x: 70, y: 330 }, size: { width: 760, height: 160 }, animations: [{ type: "slidein", duration: 0.4, direction: "left" }] },
    { id: "c1", type: "shape", shape: "rect", fill: "#16352b", start: 0.6, duration: D - 0.6, position: { x: 70, y: 600 }, size: { width: 940, height: 190 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "c1_tag", type: "shape", shape: "rect", fill: "#3fd68f", start: 0.8, duration: D - 0.8, position: { x: 70, y: 600 }, size: { width: 8, height: 190 } },
    { id: "c1_title", type: "text", content: "{{card1_title}}", fontSize: 42, color: "#3fd68f", align: "left", start: 0.8, duration: D - 0.8, position: { x: 110, y: 630 }, size: { width: 860, height: 56 } },
    { id: "c1_body", type: "text", content: "{{card1_body}}", fontSize: 30, color: "#8fbc9f", align: "left", start: 0.9, duration: D - 0.9, position: { x: 110, y: 700 }, size: { width: 860, height: 60 } },
    { id: "c2", type: "shape", shape: "rect", fill: "#16352b", start: 0.9, duration: D - 0.9, position: { x: 70, y: 830 }, size: { width: 940, height: 190 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "c2_tag", type: "shape", shape: "rect", fill: "#3fd68f", start: 1.1, duration: D - 1.1, position: { x: 70, y: 830 }, size: { width: 8, height: 190 } },
    { id: "c2_title", type: "text", content: "{{card2_title}}", fontSize: 42, color: "#3fd68f", align: "left", start: 1.1, duration: D - 1.1, position: { x: 110, y: 860 }, size: { width: 860, height: 56 } },
    { id: "c2_body", type: "text", content: "{{card2_body}}", fontSize: 30, color: "#8fbc9f", align: "left", start: 1.2, duration: D - 1.2, position: { x: 110, y: 930 }, size: { width: 860, height: 60 } },
    { id: "c3", type: "shape", shape: "rect", fill: "#16352b", start: 1.2, duration: D - 1.2, position: { x: 70, y: 1060 }, size: { width: 940, height: 190 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "c3_tag", type: "shape", shape: "rect", fill: "#facc15", start: 1.4, duration: D - 1.4, position: { x: 70, y: 1060 }, size: { width: 8, height: 190 } },
    { id: "c3_title", type: "text", content: "{{card3_title}}", fontSize: 42, color: "#facc15", align: "left", start: 1.4, duration: D - 1.4, position: { x: 110, y: 1090 }, size: { width: 860, height: 56 } },
    { id: "c3_body", type: "text", content: "{{card3_body}}", fontSize: 30, color: "#8fbc9f", align: "left", start: 1.5, duration: D - 1.5, position: { x: 110, y: 1160 }, size: { width: 860, height: 60 } },
  ],
  audio: [],
  transitions: [],
  status: "approved",
  kind: "video",
};

/** 流程图解·三步流 */
const tplFlow = {
  id: "tpl_premium_flow",
  name: "流程图解·深蓝三步流",
  content_form: "knowledge",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0f1b2d" },
  variables: [
    { name: "title", type: "text", label: "流程主题", default: "专项债项目申报全流程" },
    { name: "step_1", type: "text", label: "第一步", default: "项目储备入库" },
    { name: "step_1_desc", type: "text", label: "第一步说明", default: "发改委审核纳入储备库" },
    { name: "step_2", type: "text", label: "第二步", default: "额度分配下达" },
    { name: "step_2_desc", type: "text", label: "第二步说明", default: "财政部按因素法分配额度" },
    { name: "step_3", type: "text", label: "第三步", default: "发行与拨付" },
    { name: "step_3_desc", type: "text", label: "第三步说明", default: "省级政府发行,资金直达项目" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#0f1b2d", start: 0, duration: D, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "title", type: "text", content: "{{title}}", fontSize: 58, color: "#f1f5f9", align: "left", start: 0.3, duration: D - 0.3, position: { x: 70, y: 330 }, size: { width: 940, height: 90 }, animations: [{ type: "slidein", duration: 0.4, direction: "left" }] },
    // 步骤 1
    { id: "s1_badge", type: "shape", shape: "circle", fill: "#3b82f6", start: 0.6, duration: D - 0.6, position: { x: 90, y: 560 }, size: { width: 96, height: 96 }, animations: [{ type: "fadein", duration: 0.3 }] },
    { id: "s1_num", type: "text", content: "1", fontSize: 52, color: "#ffffff", align: "center", start: 0.6, duration: D - 0.6, position: { x: 90, y: 580 }, size: { width: 96, height: 60 } },
    { id: "s1_card", type: "shape", shape: "rect", fill: "#1e3a5f", start: 0.7, duration: D - 0.7, position: { x: 230, y: 540 }, size: { width: 780, height: 140 }, animations: [{ type: "slidein", duration: 0.4, direction: "right" }] },
    { id: "s1_text", type: "text", content: "{{step_1}}", fontSize: 44, color: "#f1f5f9", align: "left", start: 0.8, duration: D - 0.8, position: { x: 270, y: 565 }, size: { width: 700, height: 56 } },
    { id: "s1_desc", type: "text", content: "{{step_1_desc}}", fontSize: 28, color: "#94a3b8", align: "left", start: 0.9, duration: D - 0.9, position: { x: 270, y: 625 }, size: { width: 700, height: 44 } },
    // 连接条 1
    { id: "link1", type: "shape", shape: "rect", fill: "#3b82f6", start: 1.0, duration: D - 1.0, position: { x: 134, y: 660 }, size: { width: 8, height: 90 }, animations: [{ type: "fadein", duration: 0.3 }] },
    // 步骤 2
    { id: "s2_badge", type: "shape", shape: "circle", fill: "#3b82f6", start: 1.2, duration: D - 1.2, position: { x: 90, y: 760 }, size: { width: 96, height: 96 }, animations: [{ type: "fadein", duration: 0.3 }] },
    { id: "s2_num", type: "text", content: "2", fontSize: 52, color: "#ffffff", align: "center", start: 1.2, duration: D - 1.2, position: { x: 90, y: 780 }, size: { width: 96, height: 60 } },
    { id: "s2_card", type: "shape", shape: "rect", fill: "#1e3a5f", start: 1.3, duration: D - 1.3, position: { x: 230, y: 740 }, size: { width: 780, height: 140 }, animations: [{ type: "slidein", duration: 0.4, direction: "right" }] },
    { id: "s2_text", type: "text", content: "{{step_2}}", fontSize: 44, color: "#f1f5f9", align: "left", start: 1.4, duration: D - 1.4, position: { x: 270, y: 765 }, size: { width: 700, height: 56 } },
    { id: "s2_desc", type: "text", content: "{{step_2_desc}}", fontSize: 28, color: "#94a3b8", align: "left", start: 1.5, duration: D - 1.5, position: { x: 270, y: 825 }, size: { width: 700, height: 44 } },
    // 连接条 2
    { id: "link2", type: "shape", shape: "rect", fill: "#3b82f6", start: 1.6, duration: D - 1.6, position: { x: 134, y: 860 }, size: { width: 8, height: 90 }, animations: [{ type: "fadein", duration: 0.3 }] },
    // 步骤 3
    { id: "s3_badge", type: "shape", shape: "circle", fill: "#f59e0b", start: 1.8, duration: D - 1.8, position: { x: 90, y: 960 }, size: { width: 96, height: 96 }, animations: [{ type: "fadein", duration: 0.3 }] },
    { id: "s3_num", type: "text", content: "3", fontSize: 52, color: "#ffffff", align: "center", start: 1.8, duration: D - 1.8, position: { x: 90, y: 980 }, size: { width: 96, height: 60 } },
    { id: "s3_card", type: "shape", shape: "rect", fill: "#1e3a5f", start: 1.9, duration: D - 1.9, position: { x: 230, y: 940 }, size: { width: 780, height: 140 }, animations: [{ type: "slidein", duration: 0.4, direction: "right" }] },
    { id: "s3_text", type: "text", content: "{{step_3}}", fontSize: 44, color: "#f1f5f9", align: "left", start: 2.0, duration: D - 2.0, position: { x: 270, y: 965 }, size: { width: 700, height: 56 } },
    { id: "s3_desc", type: "text", content: "{{step_3_desc}}", fontSize: 28, color: "#94a3b8", align: "left", start: 2.1, duration: D - 2.1, position: { x: 270, y: 1025 }, size: { width: 700, height: 44 } },
  ],
  audio: [],
  transitions: [],
  status: "approved",
  kind: "video",
};

/** 观点大字报·深紫 */
const tplOpinion = {
  id: "tpl_premium_opinion",
  name: "观点大字报·紫金巨幕",
  content_form: "insight",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#17121f" },
  variables: [
    { name: "tag", type: "text", label: "栏目/话题标签", default: "深度观察" },
    { name: "keyword", type: "text", label: "核心观点词", default: "化债不是放水" },
    { name: "support", type: "text", label: "支撑一句", default: "置换的是期限与成本,不是新增负债" },
    { name: "author", type: "text", label: "署名", default: "@财经观察" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#17121f", start: 0, duration: D, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "tag_pill", type: "shape", shape: "rect", fill: "#a78bfa", start: 0.3, duration: D - 0.3, position: { x: 70, y: 340 }, size: { width: 220, height: 64 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "tag", type: "text", content: "{{tag}}", fontSize: 32, color: "#17121f", align: "center", start: 0.3, duration: D - 0.3, position: { x: 70, y: 354 }, size: { width: 220, height: 44 } },
    { id: "keyword", type: "text", content: "{{keyword}}", fontSize: 118, color: "#a78bfa", align: "left", start: 0.6, duration: D - 0.6, position: { x: 70, y: 620 }, size: { width: 940, height: 340 }, animations: [{ type: "slidein", duration: 0.5, direction: "bottom" }] },
    { id: "accent_line", type: "shape", shape: "rect", fill: "#f472b6", start: 0.9, duration: D - 0.9, position: { x: 70, y: 1000 }, size: { width: 120, height: 8 }, animations: [{ type: "fadein", duration: 0.4 }] },
    { id: "support", type: "text", content: "{{support}}", fontSize: 38, color: "#ede9fe", align: "left", start: 1.0, duration: D - 1.0, position: { x: 70, y: 1050 }, size: { width: 940, height: 120 }, animations: [{ type: "fadein", duration: 0.5 }] },
    { id: "author", type: "text", content: "{{author}}", fontSize: 28, color: "#a396c4", align: "left", start: 1.3, duration: D - 1.3, position: { x: 70, y: 1330 }, size: { width: 940, height: 44 } },
  ],
  audio: [],
  transitions: [],
  status: "approved",
  kind: "video",
};

const ALL = [tplFinance, tplPolicy, tplKnowledge, tplFlow, tplOpinion];

for (const tpl of ALL) {
  if (getTemplate(tpl.id)) {
    console.log(`跳过(已存在): ${tpl.id} ${tpl.name}`);
    continue;
  }
  const created = createTemplate(tpl);
  const { score, issues } = scoreTemplate(created);
  console.log(`入库: ${created.id} ${created.name} | 评分 ${score}${issues.length ? " | " + issues.map((i) => i.detail).join(" / ") : ""}`);
}
console.log("done");
