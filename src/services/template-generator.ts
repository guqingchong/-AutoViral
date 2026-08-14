/**
 * AI template generator (PRD §4.3.2).
 *
 * Uses an LLM to produce declarative JSON timeline templates, and renders a
 * 5-second sample clip for each so operators can preview/score before
 * promoting a template to "approved".
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { runJsonPrompt } from "./llm-json.js";
import { createTemplate, getTemplate, updateTemplate, listTopUsedTemplates, deleteTemplate } from "../db/templates-repo.js";
import { listSkills, touchSkill } from "../db/template-skills-repo.js";
import { renderTimeline } from "../video/renderer.js";
import { brandingToImageLayer } from "../video/branding.js";
import { buildElementsPrompt, GOLDEN_EXAMPLE, GOLDEN_EXAMPLE_NOTES, type TemplateElements } from "./template-dna.js";
import { checkTemplateQuality } from "./template-quality.js";
import type { DbTemplate, TemplateCanvas } from "../db/templates-repo.js";
import type { Timeline, TimelineLayer } from "../video/types.js";

const CONTENT_FORMS = ["hot_comment", "knowledge", "industry", "insight", "data_show", "listicle"] as const;

export interface GenerateTemplatesInput {
  /** Reference / theme hint for the generated templates（兼容旧调用，等价于 elements.freeText） */
  reference?: string;
  /** Number of templates to generate (default 5) */
  count?: number;
  /** Target content form */
  contentForm?: (typeof CONTENT_FORMS)[number];
  /** 要素化设计需求（2026-08-03 模板库优化）：版式/配色/动效/装饰 + 自由描述 */
  elements?: TemplateElements;
}

interface GeneratedTemplateRaw {
  name: string;
  content_form?: string;
  canvas: TemplateCanvas;
  variables: Array<{ name: string; type: string; default?: string | number; label?: string }>;
  layers: Record<string, unknown>[];
  audio: Record<string, unknown>[];
  transitions: Record<string, unknown>[];
}

interface LlmTemplateResponse {
  templates: GeneratedTemplateRaw[];
}

/**
 * Generate N declarative templates via LLM. Each is stored with status
 * "candidate" so it shows up in the template library for review.
 *
 * 分批生成：单批 LLM 调用约 4 分钟产出 2-3 个模板（kimi k3 实测），
 * 大 count 一次调用必然超时，故按每批 3 个顺序拆分。
 */
export async function generateTemplates(input: GenerateTemplatesInput = {}): Promise<DbTemplate[]> {
  const count = Math.min(Math.max(input.count ?? 5, 1), 10);
  const BATCH = 3;
  const created: DbTemplate[] = [];
  let lastErr: unknown;
  for (let done = 0; done < count; done += BATCH) {
    const n = Math.min(BATCH, count - done);
    try {
      const batch = await generateTemplatesBatch({ ...input, count: n });
      created.push(...batch);
    } catch (err) {
      // 单批失败不影响整体：已入库模板仍然可见
      lastErr = err;
      console.error(`[template-gen] batch ${done / BATCH + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (created.length === 0 && lastErr) throw lastErr;
  return created;
}

/** 单批生成（≤3 个模板，一次 LLM 调用） */
async function generateTemplatesBatch(input: GenerateTemplatesInput = {}): Promise<DbTemplate[]> {
  const count = Math.min(Math.max(input.count ?? 5, 1), 10);
  const form = input.elements?.contentForm ?? input.contentForm ?? "knowledge";
  const elements: TemplateElements = {
    ...input.elements,
    contentForm: form,
    freeText: input.elements?.freeText ?? input.reference,
  };

  // 技能库：调研学习沉淀的设计经验，同内容形式优先（Phase C 自进化）
  const skills = listSkills(form, 12);
  const skillsSection = skills.length > 0
    ? ["## 已调研验证的优秀模板经验（务必吸收）", ...skills.map((s, i) => `${i + 1}. ${s.skill}`), ""].join("\n")
    : "";

  // 使用统计：高频模板的要素组合是用户偏好的直接证据（Phase D 自进化）
  const topUsed = listTopUsedTemplates(3);
  const usageSection = topUsed.length > 0
    ? ["## 用户偏好信号（这些模板被实际使用最多，向它们的风格靠拢）",
        ...topUsed.map((t) => `- 「${t.name}」（${t.content_form ?? "通用"}，已用 ${t.usage_count} 次）`), ""].join("\n")
    : "";

  const prompt = [
    "你是顶级短视频视觉设计师，为抖音/小红书知识类视频设计可复用的排版模板。",
    `生成 ${count} 个符合下方设计需求的模板。`,
    "",
    "## 设计需求（由用户点选的要素组装，每条都必须满足）",
    buildElementsPrompt(elements),
    "",
    skillsSection,
    usageSection,
    "## 黄金范例（这是「精品」的标准，感受它的结构密度与参数精度）",
    "```json",
    JSON.stringify(GOLDEN_EXAMPLE, null, 1),
    "```",
    "范例为何是精品：",
    GOLDEN_EXAMPLE_NOTES,
    "你的输出必须在排版纪律、色彩纪律、节奏感上达到同等水准；若需求指定了不同的版式/配色，做同水准的变换。",
    "",
    "## 硬性规则（违反将无法解析）",
    "1. 颜色一律使用 #RRGGBB 六位实色。禁止 rgba()/rgb() 函数、禁止半透明写法",
    "2. variables 必须是数组：[{name,type,default,label}]，禁止输出对象形式",
    "3. audio 和 transitions 一律输出空数组 []",
    "4. 每个图层必须包含: id, type(shape|text), start, duration, position:{x,y}, size:{width,height}（text 层 size 可省）",
    "5. text 层必须有: content, fontSize, color, align(left|center)",
    "6. shape 层必须有: shape:\"rect\", fill, size",
    "7. canvas 固定: {width:1080, height:1920, fps:30, backgroundColor:背景色}",
    "8. 左右安全边距 70px，最底元素下缘距画布底 ≥40px",
    "",
    "## 精品设计纪律(2026-08-14 研究落地,硬性)",
    "9. 安全区:任何文字/关键元素不得进入顶部 250px 与底部 510px 区域(平台 UI 遮挡区)——标题放在 y≈300-500,正文集中在 y 500-1400 的中段",
    "10. 字号阶梯:主标题 60-96px、卡片标题 40-48px、正文 30-36px、辅助说明 ≥26px(低于此值小屏不可读)。一个画面内字号层级 ≥2 档,制造视觉层级",
    "11. 对比度:文字色与背景/底色块的对比必须强烈(深底用近白文字 #f1f5f9 级,浅底用近黑 #1c1917 级);灰字只用于次要信息",
    "12. 配色纪律:全模板 ≤3 个彩色 + 中性色(白/灰/深色底);强调色只用于关键数字/关键词,不大面积铺",
    "13. 空心边框用 stroke 表达:shape 层 fill:'#RRGGBB' 可选 stroke:{width:2-4,color} 画描边框;不要叠两个矩形模拟边框",
    "14. 每个画面至少一个有入场动效(fadein/slidein)的元素,但同一画面动效 ≤3 个,避免杂乱",
    "",
    "## 变量",
    "把主题相关文字抽象为变量（如 topic, card1_title, card1_body, stat_value, cta_text 等，按版式需要增减）。",
    "default 给出有质感的示例值，label 用中文说明。图层 content 用 {{变量名}} 引用。",
    "装饰性固定文字（如序号 01/02/03、栏目名）直接写死，不要做成变量。",
    "",
    '输出: {"templates":[{name,content_form,canvas,variables,layers,audio,transitions}]}',
  ].filter(Boolean).join("\n");

  const result = await runJsonPrompt<LlmTemplateResponse>(prompt, { timeoutMs: 300_000 });
  if (skills.length > 0) for (const s of skills) touchSkill(s.id);
  const list = result.templates ?? [];

  const created: DbTemplate[] = [];
  for (const raw0 of list.slice(0, count)) {
    // Phase B：程序化质检 + LLM 自修复（最多 2 轮），把"丑模板"拦在入库前
    const raw = await repairUntilClean(raw0, elements);
    const id = `tpl_${randomUUID().slice(0, 8)}`;

    // variables: LLM 有时返回对象 {"varName": "默认值"} 而非数组，统一转成数组
    let rawVariables: Array<{ name: string; type: string; default?: string | number; label?: string }> = [];
    if (Array.isArray(raw.variables)) {
      rawVariables = raw.variables;
    } else if (raw.variables && typeof raw.variables === "object") {
      rawVariables = Object.entries(raw.variables as Record<string, unknown>).map(([name, def]) => ({
        name,
        type: "text",
        default: typeof def === "string" || typeof def === "number" ? def : String(def ?? ""),
        label: name,
      }));
    }

    const rawLayersRaw = Array.isArray(raw.layers) ? raw.layers : [];
    // audio/transitions: 对象→数组；audio 过滤掉无 source 的占位项（无法渲染）
    const toRecordArray = (v: unknown): Record<string, unknown>[] => {
      if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
      if (v && typeof v === "object") return [v as Record<string, unknown>];
      return [];
    };
    const rawAudio = toRecordArray(raw.audio).filter(
      (a) => typeof a.source === "string" && (a.source as string).length > 0
    );
    const rawTransitions = toRecordArray(raw.transitions).filter((t) =>
      ["fade", "slide", "wipe"].includes(t.type as string)
    );

    // Normalize each layer: ensure id, start, duration, position, size all exist
    const rawLayers = rawLayersRaw.map((layer: Record<string, unknown>, i: number) => {
      const l: Record<string, unknown> = { ...layer };
      // Ensure id
      if (!l.id || typeof l.id !== "string") l.id = `layer_${i}`;
      // Ensure start
      if (typeof l.start !== "number") l.start = 0;
      // Ensure duration
      if (typeof l.duration !== "number") l.duration = 10;
      // Ensure position is {x, y}
      if (!l.position || typeof l.position !== "object") {
        l.position = { x: 0, y: 0 };
      } else {
        const pos = l.position as Record<string, unknown>;
        if (typeof pos.x !== "number") pos.x = 0;
        if (typeof pos.y !== "number") pos.y = 0;
      }
      // Ensure size for shape/image/video
      const lType = l.type as string;
      if (lType === "shape" || lType === "image" || lType === "video") {
        if (!l.size || typeof l.size !== "object") {
          l.size = { width: 100, height: 100 };
        } else {
          const sz = l.size as Record<string, unknown>;
          if (typeof sz.width !== "number") sz.width = 100;
          if (typeof sz.height !== "number") sz.height = 100;
        }
      }
      // Normalize text layer: map 'text' -> 'content', flatten 'style' object
      if (lType === "text") {
        if (!l.content && l.text) l.content = l.text;
        if (!l.content) l.content = "";
        // Flatten style object
        const style = l.style as Record<string, unknown> | undefined;
        if (style) {
          if (style.fontSize && !l.fontSize) l.fontSize = style.fontSize;
          if (style.color && !l.color) l.color = style.color;
          if (style.font && !l.fontFamily) l.fontFamily = style.font;
          if (style.align && !l.align) l.align = style.align;
          delete l.style;
        }
        if (typeof l.fontSize !== "number") l.fontSize = 40;
        if (!l.color) l.color = "#FFFFFF";
        if (!l.align) l.align = "left";
      }
      // Normalize shape layer
      if (lType === "shape") {
        if (!l.shape) l.shape = "rect";
        if (!l.fill && l.color) l.fill = l.color;
        if (!l.fill) l.fill = "#FFFFFF";
        delete l.color; // shape uses 'fill' not 'color'
      }
      // Normalize animations array
      if (l.animations && !Array.isArray(l.animations)) delete l.animations;
      return l;
    });

    const template = createTemplate({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name : `模板 ${id}`,
      content_form: (CONTENT_FORMS as readonly string[]).includes(raw.content_form ?? "") ? raw.content_form! : form,
      canvas: (() => {
        const c = raw.canvas ?? { width: 1080, height: 1920, fps: 30, backgroundColor: '#0a0a0a' };
        if (typeof c.width !== 'number') c.width = 1080;
        if (typeof c.height !== 'number') c.height = 1920;
        if (typeof c.fps !== 'number') c.fps = 30;
        if (!c.backgroundColor) c.backgroundColor = '#0a0a0a';
        return c;
      })(),
      variables: rawVariables.map((v) => ({
        name: v.name,
        type: (["text", "image", "video", "audio", "number", "color"].includes(v.type) ? v.type : "text") as
          | "text"
          | "image"
          | "video"
          | "audio"
          | "number"
          | "color",
        default: v.default,
        label: v.label,
      })),
      layers: rawLayers,
      audio: rawAudio,
      transitions: rawTransitions,
      status: "candidate",
    });
    // 精品评分门禁(2026-08-14):低于 40 分的生成结果直接拦在库外并记录原因
    const { scoreTemplate } = await import("./template-score.js");
    const scored = scoreTemplate(template as unknown as Parameters<typeof scoreTemplate>[0]);
    if (scored.score < 40) {
      console.warn(`[template-score] 「${template.name}」评分 ${scored.score} 过低,已拦在库外:`,
        scored.issues.map((i) => i.detail).join(" / "));
      deleteTemplate(id);
      continue;
    }
    if (scored.issues.length > 0) {
      console.log(`[template-score] 「${template.name}」评分 ${scored.score}:`, scored.issues.map((i) => i.detail).join(" / "));
    }
    created.push(template);
  }

  return created;
}

/**
 * Phase B 质检自修复：对 LLM 产出的单个模板跑程序化设计规则检查，
 * 有问题则连同问题清单让 LLM 定点修复，最多 2 轮；仍有残留问题也入库
 * （问题会打进日志），避免一次质检误杀整批生成。
 */
async function repairUntilClean(raw: GeneratedTemplateRaw, elements: TemplateElements): Promise<GeneratedTemplateRaw> {
  let current = raw;
  for (let round = 1; round <= 2; round++) {
    const issues = checkTemplateQuality(current as never);
    if (issues.length === 0) return current;
    console.warn(`[template-gen] quality issues (round ${round}) for "${current.name}": ${issues.map((i) => i.rule).join(", ")}`);
    const repairPrompt = [
      "你是短视频模板修复师。下面这个模板 JSON 未通过设计质检，请定点修复后原样返回完整 JSON。",
      "只修复列出的问题，不得改动其他图层结构、变量命名和整体版式。",
      "",
      "## 设计需求（修复不得偏离）",
      buildElementsPrompt(elements),
      "",
      "## 质检发现的问题",
      ...issues.map((i, idx) => `${idx + 1}. ${i.message}`),
      "",
      "## 待修复的模板 JSON",
      "```json",
      JSON.stringify(current),
      "```",
      "",
      '输出修复后的单个模板对象（不要包 templates 数组）: {name,content_form,canvas,variables,layers,audio,transitions}',
    ].join("\n");
    try {
      current = await runJsonPrompt<GeneratedTemplateRaw>(repairPrompt, { timeoutMs: 180_000, maxAttempts: 2 });
    } catch (err) {
      console.warn(`[template-gen] repair round ${round} failed:`, err instanceof Error ? err.message : err);
      break;
    }
  }
  const remaining = checkTemplateQuality(current as never);
  if (remaining.length > 0) {
    console.warn(`[template-gen] "${current.name}" still has ${remaining.length} issues after repair, keeping anyway`);
  }
  return current;
}

/**
 * Build a source-free 5-second preview timeline from a template. Video/image
 * layers (which need external files) are replaced with representative shape
 * placeholders so the preview only depends on the canvas + typography + colors.
 */
function buildPreviewTimeline(template: DbTemplate): Timeline {
  const canvas = template.canvas;
  const safeLayers: TimelineLayer[] = [];

  // Background fill - use canvas backgroundColor
  const bgColor = canvas.backgroundColor ?? "#0a0a0a";
  safeLayers.push({
    id: "preview-bg",
    type: "shape",
    shape: "rect",
    fill: bgColor,
    start: 0,
    duration: 5,
    position: { x: 0, y: 0 },
    size: { width: canvas.width, height: canvas.height },
  } as TimelineLayer);

  // Carry over ALL text and shape layers (these don't need external files)
  for (const layer of template.layers as unknown as TimelineLayer[]) {
    if (layer.type === "text" || layer.type === "shape") {
      const safeLayer: any = { ...layer };
      // Ensure required fields exist
      if (!safeLayer.id) safeLayer.id = `preview-${safeLayers.length}`;
      safeLayer.start = Math.min(layer.start ?? 0, 5);
      safeLayer.duration = Math.min(layer.duration ?? 5, 5 - (safeLayer.start ?? 0));
      // For text layers, ensure content exists
      if (safeLayer.type === "text" && !safeLayer.content) {
        safeLayer.content = safeLayer.text ?? template.name ?? "Preview";
      }
      // For text layers, resolve variable placeholders with defaults
      if (safeLayer.type === "text" && typeof safeLayer.content === "string") {
        // Replace {{varName}} with default values from template variables
        for (const v of template.variables) {
          if (v.default !== undefined) {
            safeLayer.content = safeLayer.content.replace(
              new RegExp(`{{${v.name}}}`, "g"),
              String(v.default)
            );
          }
        }
        // Remove any remaining {{...}} placeholders
        safeLayer.content = safeLayer.content.replace(/{{[^}]+}}/g, "");
      }
      // Map 'style' object to flat fields if present (LLM sometimes nests these)
      if (safeLayer.type === "text" && safeLayer.style) {
        const s = safeLayer.style;
        if (s.fontSize && !safeLayer.fontSize) safeLayer.fontSize = s.fontSize;
        if (s.color && !safeLayer.color) safeLayer.color = s.color;
        if (s.font && !safeLayer.fontFamily) safeLayer.fontFamily = s.font;
        if (s.align && !safeLayer.align) safeLayer.align = s.align;
        if (s.lineHeight) safeLayer.lineHeight = s.lineHeight;
      }
      // Map 'fill' to shape fill, 'color' for shapes too
      if (safeLayer.type === "shape") {
        if (safeLayer.color && !safeLayer.fill) safeLayer.fill = safeLayer.color;
        if (safeLayer.borderRadius) safeLayer.borderRadius = safeLayer.borderRadius;
      }
      // Ensure position is an object {x, y}, not a string
      if (typeof safeLayer.position === "string") {
        const pos = safeLayer.position;
        const size = safeLayer.size ?? { width: 100, height: 50 };
        if (pos === "center") safeLayer.position = { x: Math.round((canvas.width - size.width) / 2), y: Math.round((canvas.height - size.height) / 2) };
        else if (pos === "top") safeLayer.position = { x: Math.round((canvas.width - size.width) / 2), y: 80 };
        else if (pos === "bottom") safeLayer.position = { x: Math.round((canvas.width - size.width) / 2), y: canvas.height - size.height - 80 };
        else safeLayer.position = { x: 0, y: 0 };
      }
      // Validate required fields
      if (safeLayer.type === "shape" && !safeLayer.size) safeLayer.size = { width: 100, height: 100 };
      if (safeLayer.type === "shape" && !safeLayer.shape) safeLayer.shape = "rect";
      if (safeLayer.type === "shape" && !safeLayer.fill) safeLayer.fill = bgColor;
      if (safeLayer.type === "text" && !safeLayer.fontSize) safeLayer.fontSize = 48;
      if (safeLayer.type === "text" && !safeLayer.color) safeLayer.color = "#FFFFFF";
      if (safeLayer.type === "text" && !safeLayer.align) safeLayer.align = "left";
      safeLayers.push(safeLayer as TimelineLayer);
    }
  }

  // Skip image/video layers that need external sources (they can't render in preview)
  // But log them for debugging
  const skippedLayers = (template.layers as unknown as TimelineLayer[]).filter(
    l => l.type === "image" || l.type === "video"
  );
  if (skippedLayers.length > 0) {
    console.log(`[template-preview] Skipping ${skippedLayers.length} image/video layers (no source files)`);
  }

  return {
    canvas,
    layers: safeLayers,
    audio: [],
    transitions: template.transitions as unknown as Timeline["transitions"],
  };
}

/**
 * Render a 5-second sample clip for the given template and persist its path on
 * the template record (preview_url). Returns the output path.
 */
export async function renderTemplatePreview(templateId: string): Promise<{ previewUrl: string }> {
  const template = getTemplate(templateId);
  if (!template) throw new Error("Template not found");

  const previewDir = join(dataDir, "templates");
  await mkdir(previewDir, { recursive: true });
  const outputPath = join(previewDir, `${template.id}-preview.mp4`);

  const timeline = buildPreviewTimeline(template);
  // 模板级品牌 logo 同样进预览(所见即所得,2026-08-13);时长取预览内容长度
  if (template.branding?.logoAsset) {
    const contentDuration = Math.max(1, ...timeline.layers.map((l) => ((l as any).start ?? 0) + ((l as any).duration ?? 0)));
    timeline.layers.push(brandingToImageLayer(template.branding, template.canvas, contentDuration) as unknown as Timeline["layers"][number]);
  }
  await renderTimeline(timeline, {
    outputPath,
    duration: 5,
    preview: true,
    previewDuration: 5,
  });

  const previewUrl = `/api/templates/${template.id}/preview-file`;
  updateTemplate(template.id, { preview_url: previewUrl });
  return { previewUrl };
}