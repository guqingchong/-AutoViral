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
import { createTemplate, getTemplate, updateTemplate } from "../db/templates-repo.js";
import { renderTimeline } from "../video/renderer.js";
import type { DbTemplate, TemplateCanvas } from "../db/templates-repo.js";
import type { Timeline, TimelineLayer } from "../video/types.js";

const CONTENT_FORMS = ["hot_comment", "knowledge", "industry", "insight"] as const;

export interface GenerateTemplatesInput {
  /** Reference / theme hint for the generated templates */
  reference?: string;
  /** Number of templates to generate (default 5) */
  count?: number;
  /** Target content form */
  contentForm?: (typeof CONTENT_FORMS)[number];
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
  const form = input.contentForm ?? "knowledge";

  const prompt = [
    "你是顶级短视频视觉设计师，为抖音/小红书知识类视频设计可复用的排版模板。",
    `内容形式：${form}。生成 ${count} 个视觉风格明显不同的模板。`,
    input.reference ? `参考方向：${input.reference}` : "",
    "",
    "## 硬性规则（违反将无法解析）",
    "1. 颜色一律使用 #RRGGBB 六位实色。禁止 rgba()/rgb() 函数、禁止半透明写法",
    "2. variables 必须是数组：[{name,type,default,label}]，禁止输出对象形式",
    "3. audio 和 transitions 一律输出空数组 []",
    "4. 每个图层必须包含: id, type(shape|text), start, duration, position:{x,y}, size:{width,height}",
    "5. text 层必须有: content, fontSize, color, align(left|center)",
    "6. shape 层必须有: shape:\"rect\", fill, size",
    "7. canvas 固定: {width:1080, height:1920, fps:30, backgroundColor:背景色}",
    "",
    "## 设计系统",
    "画布 1080x1920，左右安全边距 70px，内容区宽 940px。",
    "配色方案（每个模板选一组，或自创同等水准的配色）：",
    "- 深蓝科技: bg=#0B1B33, 卡片=#16283F, 强调=#4D8DFF, 主文=#FFFFFF, 次文=#9FB4D0",
    "- 暖黑金: bg=#16130E, 卡片=#241F16, 强调=#F0B64C, 主文=#FFF7E8, 次文=#B8A88A",
    "- 墨绿知识: bg=#0C1F17, 卡片=#173024, 强调=#3FD68F, 主文=#EFFFF5, 次文=#8FC7A8",
    "- 深紫洞察: bg=#1A1030, 卡片=#271B45, 强调=#A98BFF, 主文=#F5F0FF, 次文=#B3A3D9",
    "- 米白简约: bg=#F5F1E8, 卡片=#FFFFFF, 强调=#E85D4A, 主文=#241F16, 次文=#8A8070",
    "- 雾蓝清爽: bg=#101820, 卡片=#1C2836, 强调=#5AC8D8, 主文=#FFFFFF, 次文=#8FA5B3",
    "",
    "## 排版结构（每个模板完整实现）",
    "1. bg: 全屏背景 shape（fill=bg 色, position {x:0,y:0}, size 1080x1920, start 0, duration 10）",
    "2. 顶部装饰条: shape, 宽 120-200px, 高 8-12px, 强调色, y≈64",
    "3. 标签文字: 小号(22-26px)强调色, y≈96, 内容如「行业周报」「知识卡片」",
    "4. 主标题: 56-72px 主文色, 左对齐, y≈170, 不超过 13 个字",
    "5. 副标题: 28-34px 次文色, y≈270, 不超过 20 个字",
    "6. 三张内容卡片，每张包含:",
    "   - 卡片底 shape: 卡片色, x=70, 宽 940, 高 240-300",
    "   - 左侧强调条 shape: 宽 8px, 高与卡片相同, 强调色, 与卡片同 x,y",
    "   - 序号文字: 24-30px 强调色（如 01 / 02 / 03）",
    "   - 卡片标题: 32-38px 主文色, 不超过 16 字, 用 {{cardN_title}} 变量",
    "   - 卡片正文: 26-30px 次文色, 不超过 26 字, 用 {{cardN_body}} 变量",
    "   - 三张卡片 y 坐标依次排开（如 420 / 760 / 1100）",
    "7. 数据区: 大数字(80-96px 强调色, {{stat_value}}) + 说明小字(24-28px 次文色, {{stat_label}}), y≈1450",
    "8. 底部 CTA: 强调色条 shape(宽 940 高 72, y≈1700) + CTA 文字(30px, 居中, {{cta_text}})",
    "",
    "## 动效（让模板有节奏感）",
    "- bg、装饰条 start=0, duration=10",
    "- 标题组 start=0.2；卡片组 start 依次为 0.5 / 0.8 / 1.1；数据区 start=1.4；CTA start=1.7",
    "- 所有非 bg 图层 duration 补到 10 秒（如 start=0.5 则 duration=9.5）",
    "- text 层附 animations: [{\"type\":\"slidein\",\"duration\":0.4,\"direction\":\"bottom\"}]",
    "",
    "## 变量",
    "把主题相关文字抽象为变量: topic, card1_title, card1_body, card2_title, card2_body, card3_title, card3_body, stat_value, stat_label, cta_text。",
    "default 给出有质感的示例值，label 用中文说明。图层 content 用 {{变量名}} 引用。",
    "",
    "## 多样性要求",
    "多个模板之间版式必须明显不同（左对齐杂志风 / 居中大数字风 / 顶部大色块标题风 / 上下分屏风等），不允许只换配色。",
    "",
    '输出: {"templates":[{name,content_form,canvas,variables,layers,audio,transitions}]}',
  ].join("\n");

  const result = await runJsonPrompt<LlmTemplateResponse>(prompt, { timeoutMs: 300_000 });
  const list = result.templates ?? [];

  const created: DbTemplate[] = [];
  for (const raw of list.slice(0, count)) {
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
    created.push(template);
  }

  return created;
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