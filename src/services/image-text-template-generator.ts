/**
 * 图文模板 AI 生成器（2026-08-05 批量制作弹窗整改 §4）。
 *
 * 与视频模板生成器（template-generator.ts）的区别：视频模板产出的是
 * 时间线 layers（text/shape 逐帧排版），图文模板产出的是「版式方案」——
 * 封面页 + 内容页的布局、字体、配色、装饰元素，供图文产物（知乎/公众号
 * 插图、小红书图片卡片）套用。
 *
 * LLM 产出 { name, cover, contentPage }（cover/contentPage 均为 LayoutSpec），
 * 校验后存 templates 表（kind = "image-text"）：版式 JSON 存 layers 字段
 * （cover / content-page 两条记录），画布固定 1080x1440（小红书 3:4）。
 * 预览图基建（poster 渲染）目前只支持视频时间线模板，故 preview_url 留空。
 */

import { randomUUID } from "node:crypto";
import { runJsonPrompt } from "./llm-json.js";
import { createTemplate } from "../db/templates-repo.js";
import { validateDeclaredCapabilities } from "./template-dna.js";
import type { DbTemplate, TemplateCanvas } from "../db/templates-repo.js";

export interface GenerateImageTextTemplatesInput {
  /** Number of templates to generate (default 3, max 5) */
  count?: number;
}

/** 图文版式方案（封面页或内容页） */
export interface LayoutSpec {
  /** 版式结构，如 "big_title_center" / "magazine_left" / "card_stack" */
  layout: string;
  /** 字体族，如 "Noto Sans SC" */
  font: string;
  /** 主标题字号（px） */
  fontSize: number;
  /** 配色方案：{ background, primary, text, accent, ... } 均为 #RRGGBB */
  colorScheme: Record<string, string>;
  /** 装饰元素 key 列表，如 ["accent_bar", "serial_number"] */
  decorations: string[];
}

interface GeneratedImageTextTemplateRaw {
  name?: unknown;
  cover?: unknown;
  contentPage?: unknown;
}

interface LlmImageTextResponse {
  templates?: GeneratedImageTextTemplateRaw[];
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_COLOR_SCHEME: Record<string, string> = {
  background: "#FFFFFF",
  primary: "#1A1A1A",
  text: "#333333",
  accent: "#FF2E4D",
};

/**
 * 校验并规范化 LLM 产出的 LayoutSpec；结构不可用返回 null。
 * 宽容策略：layout 缺失/非字符串即不可用（它是版式的核心），
 * 其余字段给合理默认值，避免一次小瑕疵误杀整个方案。
 */
export function normalizeLayoutSpec(raw: unknown): LayoutSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.layout !== "string" || !r.layout.trim()) return null;

  const colorScheme: Record<string, string> = { ...DEFAULT_COLOR_SCHEME };
  if (r.colorScheme && typeof r.colorScheme === "object") {
    for (const [k, v] of Object.entries(r.colorScheme as Record<string, unknown>)) {
      if (typeof v === "string" && HEX_COLOR.test(v)) colorScheme[k] = v.toUpperCase();
    }
  }

  return {
    layout: r.layout.trim(),
    font: typeof r.font === "string" && r.font.trim() ? r.font.trim() : "Noto Sans SC",
    fontSize: typeof r.fontSize === "number" && r.fontSize > 0 ? Math.round(r.fontSize) : 64,
    colorScheme,
    decorations: Array.isArray(r.decorations)
      ? (r.decorations as unknown[]).filter((d): d is string => typeof d === "string" && d.length > 0)
      : [],
  };
}

/** 校验单个图文模板方案（name + cover + contentPage），不可用返回 null */
export function normalizeImageTextTemplate(raw: GeneratedImageTextTemplateRaw): {
  name: string;
  cover: LayoutSpec;
  contentPage: LayoutSpec;
} | null {
  const cover = normalizeLayoutSpec(raw?.cover);
  const contentPage = normalizeLayoutSpec(raw?.contentPage);
  if (!cover || !contentPage) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  return { name: name || "未命名图文模板", cover, contentPage };
}

/**
 * Generate N image-text layout templates via LLM. Each is stored with
 * status "candidate" and kind "image-text" so it shows up in the template
 * library under the 图文模板 category for review.
 */
export async function generateImageTextTemplates(input: GenerateImageTextTemplatesInput = {}): Promise<DbTemplate[]> {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);

  const prompt = [
    "你是顶级图文内容视觉设计师，为小红书/公众号图文内容设计可复用的版式模板。",
    `生成 ${count} 个图文模板方案。每个方案包含封面页（cover）和内容页（contentPage）两个版式。`,
    "",
    "## 设计要求",
    "1. 画布固定 1080x1440（3:4 竖版，小红书标准卡片比例）",
    "2. 封面页：大标题视觉冲击，3 秒内传达主题；内容页：正文排版清晰易读，段落层级分明",
    "3. 封面与内容页必须风格统一（同色系、同字体族）",
    "4. 配色给出完整 colorScheme：background / primary（主色）/ text（正文色）/ accent（点缀色），全部 #RRGGBB 六位实色",
    "5. font 用常见中文字体（如 Noto Sans SC、思源黑体、站酷高端黑），fontSize 指主标题字号（封面 72-120，内容页 48-72）",
    "6. decorations 从以下选择 0-3 个：accent_bar（装饰条）、serial_number（序号）、divider（分隔线）、texture（底纹）、corner_marks（角标）",
    "7. layout 用蛇形命名描述版式结构，如 big_title_center、magazine_left、top_block、card_stack、split_screen、fullscreen_caption",
    "8. 各方案风格要拉开差异：简约/杂志/撞色/国风/科技感等，不要同质化",
    "",
    "## 输出格式",
    '{"templates":[{"name":"模板名称","cover":{"layout":"...","font":"...","fontSize":96,"colorScheme":{"background":"#FFFFFF","primary":"#1A1A1A","text":"#333333","accent":"#FF2E4D"},"decorations":["accent_bar"]},"contentPage":{同 cover 结构}}]}',
  ].join("\n");

  const result = await runJsonPrompt<LlmImageTextResponse>(prompt, { timeoutMs: 300_000 });
  const list = Array.isArray(result.templates) ? result.templates : [];

  const created: DbTemplate[] = [];
  for (const raw of list.slice(0, count)) {
    const normalized = normalizeImageTextTemplate(raw);
    if (!normalized) {
      console.warn("[image-text-template-gen] skipping invalid template spec:", JSON.stringify(raw).slice(0, 200));
      continue;
    }
    const id = `tpl_it_${randomUUID().slice(0, 8)}`;
    const canvas: TemplateCanvas = {
      width: 1080,
      height: 1440,
      fps: 30,
      backgroundColor: normalized.cover.colorScheme.background ?? "#FFFFFF",
    };
    const layers = [
      { id: "cover", type: "image-text-layout", page: "cover", ...normalized.cover },
      { id: "content-page", type: "image-text-layout", page: "content", ...normalized.contentPage },
    ];
    // 批次8.5:声明-能力一致性——渲染端未实现的 layout/decorations 声明拒绝入库
    const capIssues = validateDeclaredCapabilities({ kind: "image-text", layers });
    if (capIssues.length) {
      console.warn(`[image-text-template-gen] 跳过能力越界的模版 ${normalized.name}: ${capIssues.join("; ")}`);
      continue;
    }
    const template = createTemplate({
      id,
      name: normalized.name,
      content_form: "image-text",
      canvas,
      variables: [],
      // 版式 JSON 存 layers：cover / content-page 两条记录（渲染引擎按 type 识别）
      layers,
      audio: [],
      transitions: [],
      status: "candidate",
      kind: "image-text",
    });
    created.push(template);
  }

  if (created.length === 0) {
    throw new Error("图文模板生成失败：LLM 产出无法解析为有效版式方案");
  }
  return created;
}
