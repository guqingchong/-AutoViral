/**
 * 双产物派生（2026-08-05 批量制作弹窗整改 §2）。
 *
 * dual_output=1 的作品（批量制作选「短视频+图文」）在视频流水线完成、进入
 * reviewing 时异步派生图文产物：
 *
 * 1. 图文文章（知乎/公众号）：文章正文 + 段落插图。文章内容在 batch-convert
 *    时已写入 articles 表，素材图在 works/<id>/assets/images/，发布时由
 *    buildPublishInput 的 contentImages 机制收集 —— 本模块只做接线验证
 *   （文章存在性检查），配图收集在发布链路已就绪。
 * 2. 小红书图+文卡片：把文章要点拆成卡片文案（LLM，失败回退程序化拆分），
 *    按图文模板版式（templates 表 kind=image-text 的 LayoutSpec）渲染成
 *    PNG 卡片，存 works/<id>/output/cards/（01-cover.png、02-card.png…）。
 *    渲染走 Playwright HTML→截图（项目已有依赖，无 sharp/canvas 基建）。
 *
 * 失败不阻塞作品进 reviewing：deriveDualOutputs 内部全程捕获，仅记日志。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { log } from "../logger.js";
import { getWork } from "../db/works-repo.js";
import { listArticlesByWork } from "../db/articles-repo.js";
import { getTemplate, listTemplates, type DbTemplate, type TemplateCanvas } from "../db/templates-repo.js";
import { normalizeLayoutSpec, type LayoutSpec } from "./image-text-template-generator.js";
import { runJsonPrompt } from "./llm-json.js";

// ── 卡片文案数据结构 ─────────────────────────────────────────────────────────

export interface CardPage {
  heading?: string;
  body: string;
}

export interface CardCopy {
  coverTitle: string;
  coverSubtitle?: string;
  pages: CardPage[];
}

/** 小红书单帖最多 9 图：1 封面 + 8 内容卡 */
const MAX_CONTENT_PAGES = 8;
const DEFAULT_MAX_PAGES = 6;
/** 内容卡正文默认字数上限（小红书卡片可读性） */
const DEFAULT_MAX_BODY_CHARS = 140;
const COVER_TITLE_MAX = 20;
const COVER_SUBTITLE_MAX = 30;
const HEADING_MAX = 14;

// ── 文章 → 卡片文案（程序化拆分，LLM 失败时的兜底） ──────────────────────────

/** 去掉 markdown 标记（标题 #、图片、链接、粗斜体），保留纯文本 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接留文字
    .replace(/^#{1,6}\s*/gm, "") // 标题记号
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^[>\-\*]\s+/gm, "") // 引用/列表记号
    .trim();
}

/** 把长段落按句子边界（。！？；）切成 ≤ maxChars 的块 */
function splitLongParagraph(para: string, maxChars: number): string[] {
  if (para.length <= maxChars) return [para];
  const sentences = para.split(/(?<=[。！？；!?;])/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > maxChars) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  // 单句仍超限 → 硬切
  const result: string[] = [];
  for (const c of chunks) {
    if (c.length <= maxChars) result.push(c);
    else for (let i = 0; i < c.length; i += maxChars) result.push(c.slice(i, i + maxChars));
  }
  return result;
}

/**
 * 程序化拆分：文章正文按段落映射成内容卡（一段一卡）。
 * 封面取文章标题；段落先按空行切，只有一段时按单行切；超长按句子再切成多卡。
 */
export function splitArticleToCardCopy(
  title: string,
  content: string,
  opts: { maxPages?: number; maxBodyChars?: number } = {},
): CardCopy {
  const maxPages = Math.min(Math.max(opts.maxPages ?? DEFAULT_MAX_PAGES, 1), MAX_CONTENT_PAGES);
  const maxBodyChars = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  const cleaned = stripMarkdown(content);
  let paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    paragraphs = cleaned.split(/\n/).map((p) => p.trim()).filter(Boolean);
  }

  const pages: CardPage[] = [];
  for (const para of paragraphs) {
    if (pages.length >= maxPages) break;
    for (const chunk of splitLongParagraph(para, maxBodyChars)) {
      if (pages.length >= maxPages) break;
      pages.push({ body: chunk });
    }
  }

  return {
    coverTitle: (title || "未命名").trim().slice(0, COVER_TITLE_MAX),
    pages: pages.slice(0, maxPages),
  };
}

// ── LLM 卡片文案 ─────────────────────────────────────────────────────────────

/** 校验/规范化 LLM 产出的卡片文案；完全不可用返回 null（调用方回退程序化拆分） */
export function normalizeLlmCardCopy(raw: unknown, fallbackTitle: string): CardCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const coverTitleRaw = typeof r.coverTitle === "string" ? r.coverTitle.trim() : "";
  const coverTitle = (coverTitleRaw || fallbackTitle.trim() || "未命名").slice(0, COVER_TITLE_MAX);

  const coverSubtitle =
    typeof r.coverSubtitle === "string" && r.coverSubtitle.trim()
      ? r.coverSubtitle.trim().slice(0, COVER_SUBTITLE_MAX)
      : undefined;

  const rawPages = Array.isArray(r.pages) ? r.pages : [];
  const pages: CardPage[] = [];
  for (const p of rawPages) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    const body = typeof obj.body === "string" ? obj.body.trim() : "";
    if (!body) continue;
    const heading =
      typeof obj.heading === "string" && obj.heading.trim()
        ? obj.heading.trim().slice(0, HEADING_MAX)
        : undefined;
    pages.push({ heading, body: body.slice(0, DEFAULT_MAX_BODY_CHARS + 40) });
    if (pages.length >= MAX_CONTENT_PAGES) break;
  }
  if (pages.length === 0) return null;

  return { coverTitle, coverSubtitle, pages };
}

export interface GenerateCardCopyOptions {
  /** 注入的 LLM 调用（测试用）；缺省走 runJsonPrompt */
  llm?: (prompt: string) => Promise<unknown>;
}

/**
 * 生成卡片文案：先 LLM（口语化、要点提炼），任何失败/产出不可用都回退
 * 到程序化段落拆分 —— 卡片产物不允许因 LLM 故障而缺失。
 */
export async function generateCardCopy(
  article: { title: string; content: string },
  opts: GenerateCardCopyOptions = {},
): Promise<CardCopy> {
  const callLlm = opts.llm ?? ((prompt: string) => runJsonPrompt<unknown>(prompt, { timeoutMs: 180_000 }));
  const prompt = [
    "你是小红书图文内容编辑。把下面这篇文章改写成小红书图片卡片的文案。",
    "",
    "## 要求",
    `1. coverTitle：封面大标题，不超过${COVER_TITLE_MAX}字，有冲击力，3秒传达主题`,
    `2. coverSubtitle：封面副标题，不超过${COVER_SUBTITLE_MAX}字，可以为空字符串`,
    `3. pages：3-${DEFAULT_MAX_PAGES} 张内容卡，每张 {"heading":"小标题(不超过${HEADING_MAX}字)","body":"正文(不超过${DEFAULT_MAX_BODY_CHARS}字)"}`,
    "4. body 口语化、提炼要点，保留关键信息和金句，不要照抄长段落",
    "5. 各卡片合起来覆盖文章核心脉络，按原文逻辑顺序组织",
    "",
    "## 输出格式（只输出 JSON）",
    '{"coverTitle":"...","coverSubtitle":"...","pages":[{"heading":"...","body":"..."}]}',
    "",
    `## 文章标题\n${article.title}`,
    "",
    `## 文章正文\n${article.content.slice(0, 6000)}`,
  ].join("\n");

  try {
    const raw = await callLlm(prompt);
    const normalized = normalizeLlmCardCopy(raw, article.title);
    if (normalized) return normalized;
    log("warn", "server", "dual_output_card_copy_llm_invalid", undefined, { title: article.title });
  } catch (err) {
    log("warn", "server", "dual_output_card_copy_llm_failed", undefined, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return splitArticleToCardCopy(article.title, article.content);
}

// ── 版式解析 ─────────────────────────────────────────────────────────────────

export interface CardLayout {
  cover: LayoutSpec;
  content: LayoutSpec;
  canvas: { width: number; height: number };
  templateId?: string;
}

const DEFAULT_COVER_SPEC: LayoutSpec = {
  layout: "big_title_center",
  font: "Noto Sans SC",
  fontSize: 96,
  colorScheme: { background: "#FFFFFF", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" },
  decorations: ["accent_bar"],
};

const DEFAULT_CONTENT_SPEC: LayoutSpec = {
  layout: "top_block",
  font: "Noto Sans SC",
  fontSize: 56,
  colorScheme: { background: "#FFFFFF", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" },
  decorations: ["serial_number"],
};

/** 从 kind=image-text 模板的 layers 提取 cover/content 两条 LayoutSpec；不完整返回 null */
export function layoutSpecsFromTemplate(template: DbTemplate): { cover: LayoutSpec; content: LayoutSpec } | null {
  if (template.kind !== "image-text") return null;
  let cover: LayoutSpec | null = null;
  let content: LayoutSpec | null = null;
  for (const layer of template.layers) {
    if (layer.type !== "image-text-layout") continue;
    if (layer.page === "cover" && !cover) cover = normalizeLayoutSpec(layer);
    else if (layer.page === "content" && !content) content = normalizeLayoutSpec(layer);
  }
  return cover && content ? { cover, content } : null;
}

/**
 * 解析卡片版式：优先作品自带模板（若是 image-text 类），否则取最新的
 * 已批准/候选图文模板，都没有则用内置默认版式 —— 任何情况下都能出图。
 */
export function resolveCardLayout(workTemplateId?: string): CardLayout {
  const canvas = { width: 1080, height: 1440 };

  if (workTemplateId) {
    const tpl = getTemplate(workTemplateId);
    if (tpl) {
      const specs = layoutSpecsFromTemplate(tpl);
      if (specs) return { ...specs, canvas: tplCanvas(tpl), templateId: tpl.id };
    }
  }

  for (const status of ["approved", "candidate"] as const) {
    const tpl = listTemplates(status, undefined, "image-text", 1)[0];
    if (tpl) {
      const specs = layoutSpecsFromTemplate(tpl);
      if (specs) return { ...specs, canvas: tplCanvas(tpl), templateId: tpl.id };
    }
  }

  return { cover: DEFAULT_COVER_SPEC, content: DEFAULT_CONTENT_SPEC, canvas };
}

function tplCanvas(tpl: DbTemplate): { width: number; height: number } {
  const c: TemplateCanvas | undefined = tpl.canvas;
  return {
    width: typeof c?.width === "number" && c.width > 0 ? c.width : 1080,
    height: typeof c?.height === "number" && c.height > 0 ? c.height : 1440,
  };
}

// ── 卡片 HTML 渲染 ───────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface CardHtmlInput {
  spec: LayoutSpec;
  canvas: { width: number; height: number };
  kind: "cover" | "content";
  title?: string;
  subtitle?: string;
  heading?: string;
  body?: string;
  /** 内容卡序号（1 起）与总数，serial_number 装饰用 */
  index?: number;
  total?: number;
}

/** 把一张卡片的文案 + LayoutSpec 渲染成独立 HTML 文档（截图出 PNG 用） */
export function buildCardHtml(input: CardHtmlInput): string {
  const { spec, canvas, kind } = input;
  const cs = spec.colorScheme;
  const bg = cs.background ?? "#FFFFFF";
  const primary = cs.primary ?? "#1A1A1A";
  const text = cs.text ?? "#333333";
  const accent = cs.accent ?? "#FF2E4D";
  const deco = new Set(spec.decorations);
  const isCenter = kind === "cover" || /center/.test(spec.layout);

  const titleSize = spec.fontSize;
  const bodySize = Math.max(28, Math.round(spec.fontSize * 0.55));
  const subSize = Math.max(24, Math.round(spec.fontSize * 0.38));

  const parts: string[] = [];

  if (deco.has("corner_marks")) {
    parts.push(`<div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>`);
  }
  if (deco.has("serial_number") && kind === "content" && input.index != null && input.total != null) {
    parts.push(
      `<div class="serial">${String(input.index).padStart(2, "0")} / ${String(input.total).padStart(2, "0")}</div>`,
    );
  }

  if (kind === "cover") {
    if (deco.has("accent_bar")) parts.push(`<div class="accent-bar"></div>`);
    parts.push(`<div class="cover-title">${escapeHtml(input.title ?? "")}</div>`);
    if (input.subtitle) parts.push(`<div class="cover-subtitle">${escapeHtml(input.subtitle)}</div>`);
  } else {
    if (input.heading) {
      if (deco.has("accent_bar")) parts.push(`<div class="accent-bar"></div>`);
      parts.push(`<div class="heading">${escapeHtml(input.heading)}</div>`);
    }
    if (deco.has("divider")) parts.push(`<div class="divider"></div>`);
    parts.push(`<div class="body">${escapeHtml(input.body ?? "").replace(/\n/g, "<br/>")}</div>`);
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${canvas.width}px; height: ${canvas.height}px; }
body {
  background: ${bg};
  color: ${text};
  font-family: "${spec.font}", "PingFang SC", "Microsoft YaHei", sans-serif;
  display: flex; flex-direction: column;
  justify-content: ${isCenter ? "center" : "flex-start"};
  align-items: ${isCenter ? "center" : "stretch"};
  text-align: ${isCenter ? "center" : "left"};
  padding: 90px 80px;
  position: relative;
  overflow: hidden;
}
${deco.has("texture") ? `body::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(45deg, transparent 0 18px, ${accent}11 18px 20px); }` : ""}
.accent-bar { width: 120px; height: 12px; background: ${accent}; border-radius: 6px; margin-bottom: 48px; }
.cover-title { color: ${primary}; font-size: ${titleSize}px; font-weight: 800; line-height: 1.3; word-break: break-word; }
.cover-subtitle { color: ${text}; font-size: ${subSize}px; line-height: 1.6; margin-top: 40px; opacity: 0.85; }
.heading { color: ${primary}; font-size: ${titleSize}px; font-weight: 700; line-height: 1.35; margin-bottom: 32px; }
.divider { width: 100%; height: 2px; background: ${accent}55; margin: 8px 0 40px; }
.body { color: ${text}; font-size: ${bodySize}px; line-height: 1.9; word-break: break-word; white-space: normal; }
.serial { position: absolute; top: 48px; right: 64px; color: ${accent}; font-size: 30px; font-weight: 600; letter-spacing: 2px; }
.corner { position: absolute; width: 44px; height: 44px; border: 6px solid ${accent}; }
.corner.tl { top: 28px; left: 28px; border-right: none; border-bottom: none; }
.corner.tr { top: 28px; right: 28px; border-left: none; border-bottom: none; }
.corner.bl { bottom: 28px; left: 28px; border-right: none; border-top: none; }
.corner.br { bottom: 28px; right: 28px; border-left: none; border-top: none; }
</style></head><body>${parts.join("\n")}</body></html>`;
}

/** 单张 HTML → PNG 的渲染器签名（测试可注入 mock，缺省 Playwright 截图） */
export type CardRenderer = (
  html: string,
  outPath: string,
  canvas: { width: number; height: number },
) => Promise<void>;

/** 默认渲染器：Playwright 无头 Chromium 截图（项目已有依赖，无 sharp/canvas 基建） */
async function renderWithPlaywright(
  pages: Array<{ html: string; outPath: string }>,
  canvas: { width: number; height: number },
): Promise<void> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: canvas.width, height: canvas.height } });
    for (const p of pages) {
      await page.setContent(p.html, { waitUntil: "load" });
      await page.screenshot({ path: p.outPath, type: "png" });
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

export interface RenderedCards {
  cardsDir: string;
  /** 有序卡片文件绝对路径：01-cover.png 在最前 */
  files: string[];
}

/**
 * 把卡片文案按版式渲染成 PNG 序列，写入 outDir（works/<id>/output/cards/）。
 * 文件名 01-cover.png / 02-card.png … 字典序即展示顺序。
 * render 注入点：传入时逐张调用；缺省用一个浏览器实例批量截图。
 */
export async function renderCardsToPng(
  copy: CardCopy,
  layout: CardLayout,
  outDir: string,
  render?: CardRenderer,
): Promise<RenderedCards> {
  await mkdir(outDir, { recursive: true });

  const jobs: Array<{ html: string; outPath: string }> = [];
  jobs.push({
    html: buildCardHtml({
      spec: layout.cover,
      canvas: layout.canvas,
      kind: "cover",
      title: copy.coverTitle,
      subtitle: copy.coverSubtitle,
    }),
    outPath: join(outDir, "01-cover.png"),
  });
  copy.pages.forEach((p, i) => {
    jobs.push({
      html: buildCardHtml({
        spec: layout.content,
        canvas: layout.canvas,
        kind: "content",
        heading: p.heading,
        body: p.body,
        index: i + 1,
        total: copy.pages.length,
      }),
      outPath: join(outDir, `${String(i + 2).padStart(2, "0")}-card.png`),
    });
  });

  if (render) {
    for (const j of jobs) await render(j.html, j.outPath, layout.canvas);
  } else {
    await renderWithPlaywright(jobs, layout.canvas);
  }

  return { cardsDir: outDir, files: jobs.map((j) => j.outPath) };
}

// ── 派生主流程 ───────────────────────────────────────────────────────────────

export interface DeriveDualOutputsResult {
  /** 图文文章产物就绪（文章存在，发布链路可获取内容 + 素材图） */
  articleReady: boolean;
  /** 小红书卡片产物 */
  cardFiles: string[];
  cardsDir?: string;
}

export interface DeriveDualOutputsDeps {
  generateCopy?: (article: { title: string; content: string }) => Promise<CardCopy>;
  render?: CardRenderer;
}

/**
 * dual_output 作品进入 reviewing 时的派生入口。
 * 不抛异常 —— 任何失败记日志后返回已产出的部分结果。
 */
export async function deriveDualOutputs(
  workId: string,
  deps: DeriveDualOutputsDeps = {},
): Promise<DeriveDualOutputsResult | null> {
  const result: DeriveDualOutputsResult = { articleReady: false, cardFiles: [] };
  try {
    const work = getWork(workId);
    if (!work || !work.dual_output) return null;

    // 1. 图文文章（知乎/公众号）：文章内容 + 素材图发布时由 buildPublishInput
    //    的 content/contentImages 机制获取（已就绪），这里验证文章存在。
    const article = listArticlesByWork(workId)[0];
    if (article?.content) {
      result.articleReady = true;
    } else {
      log("warn", "server", "dual_output_no_article", workId, {
        msg: "双产物作品无文章，知乎/公众号发布将退化为标题占位文本",
      });
    }

    // 2. 小红书图+文卡片：需要文章作为卡片文案来源
    if (article?.content) {
      try {
        const layout = resolveCardLayout(work.template_id);
        const copy = deps.generateCopy
          ? await deps.generateCopy({ title: article.title, content: article.content })
          : await generateCardCopy({ title: article.title, content: article.content });
        if (copy.pages.length === 0) {
          log("warn", "server", "dual_output_empty_card_copy", workId, {});
        } else {
          const cardsDir = join(dataDir, "works", workId, "output", "cards");
          const rendered = await renderCardsToPng(copy, layout, cardsDir, deps.render);
          result.cardFiles = rendered.files;
          result.cardsDir = rendered.cardsDir;
          // 产物清单：发布链路/前端按此展示卡片产物
          await writeFile(
            join(cardsDir, "cards.json"),
            JSON.stringify(
              {
                workId,
                title: article.title,
                templateId: layout.templateId ?? null,
                generatedAt: new Date().toISOString(),
                files: rendered.files.map((f) => f.split(/[\\/]/).pop()),
              },
              null,
              2,
            ),
            "utf-8",
          );
        }
      } catch (err) {
        log("error", "server", "dual_output_cards_failed", workId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log("info", "server", "dual_output_derived", workId, {
      articleReady: result.articleReady,
      cards: result.cardFiles.length,
    });
    return result;
  } catch (err) {
    log("error", "server", "dual_output_derive_failed", workId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}
