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

import { mkdir, writeFile, cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { log } from "../logger.js";
import { getWork, getChildWorkByParent, createWork } from "../db/works-repo.js";
import { listArticlesByWork, createArticle, updateArticle } from "../db/articles-repo.js";
import { getTemplate, listTemplates, type DbTemplate, type TemplateCanvas } from "../db/templates-repo.js";
import { normalizeLayoutSpec, type LayoutSpec } from "./image-text-template-generator.js";
import { runJsonPrompt } from "./llm-json.js";
import type { DbWork } from "../db/types.js";

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
  /** 素材图 URL（file:// 或 http）：提供时卡片渲染为「图+文」形态 */
  imageUrl?: string;
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
  const hasImage = Boolean(input.imageUrl);

  // 图+文形态:图片约占版面 45%(内容卡)/55%(封面),文字区相应压缩字号
  const titleSize = hasImage ? Math.round(spec.fontSize * 0.78) : spec.fontSize;
  const bodySize = Math.max(28, Math.round(spec.fontSize * (hasImage ? 0.42 : 0.55)));
  const subSize = Math.max(24, Math.round(spec.fontSize * 0.38));
  const imgHeight = Math.round(canvas.height * (kind === "cover" ? 0.55 : 0.45));

  const parts: string[] = [];

  if (deco.has("corner_marks")) {
    parts.push(`<div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>`);
  }
  if (deco.has("serial_number") && kind === "content" && input.index != null && input.total != null) {
    parts.push(
      `<div class="serial">${String(input.index).padStart(2, "0")} / ${String(input.total).padStart(2, "0")}</div>`,
    );
  }

  if (hasImage) {
    parts.push(`<div class="img-wrap"><img src="${input.imageUrl}" alt=""/></div>`);
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

  // 图+文形态:图片置顶通栏,文字区居中偏下;无图时维持原纯文版式
  const textPadding = hasImage ? "48px 72px" : "90px 80px";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${canvas.width}px; height: ${canvas.height}px; }
body {
  background: ${bg};
  color: ${text};
  font-family: "${spec.font}", "PingFang SC", "Microsoft YaHei", sans-serif;
  display: flex; flex-direction: column;
  justify-content: ${hasImage ? "flex-start" : isCenter ? "center" : "flex-start"};
  align-items: ${isCenter ? "center" : "stretch"};
  text-align: ${isCenter ? "center" : "left"};
  padding: ${hasImage ? "0" : textPadding};
  position: relative;
  overflow: hidden;
}
${hasImage ? `.img-wrap { width: 100%; height: ${imgHeight}px; overflow: hidden; flex: 0 0 auto; }
.img-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-title, .cover-subtitle, .heading, .body, .accent-bar, .divider { margin-left: 72px; margin-right: 72px; }
.cover-title { margin-top: 48px; } .heading { margin-top: 40px; }` : ""}
${deco.has("texture") ? `body::before { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(45deg, transparent 0 18px, ${accent}11 18px 20px); }` : ""}
.accent-bar { width: 120px; height: 12px; background: ${accent}; border-radius: 6px; margin-bottom: ${hasImage ? "28px" : "48px"}; ${hasImage ? "margin-top: 40px;" : ""} }
.cover-title { color: ${primary}; font-size: ${titleSize}px; font-weight: 800; line-height: 1.3; word-break: break-word; }
.cover-subtitle { color: ${text}; font-size: ${subSize}px; line-height: 1.6; margin-top: 28px; opacity: 0.85; }
.heading { color: ${primary}; font-size: ${titleSize}px; font-weight: 700; line-height: 1.35; margin-bottom: 24px; }
.divider { width: calc(100% - 144px); height: 2px; background: ${accent}55; margin: 8px 0 32px; }
.body { color: ${text}; font-size: ${bodySize}px; line-height: 1.9; word-break: break-word; white-space: normal; }
.serial { position: absolute; top: 48px; right: 64px; color: ${accent}; font-size: 30px; font-weight: 600; letter-spacing: 2px; ${hasImage ? "background: rgba(255,255,255,0.85); border-radius: 6px; padding: 2px 10px;" : ""} }
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
      // 卡片含素材图(file://)时等图片真正加载完再截图
      await page
        .waitForFunction(() => Array.from(document.images).every((i) => i.complete), { timeout: 15000 })
        .catch(() => {});
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
  images?: string[],
): Promise<RenderedCards> {
  await mkdir(outDir, { recursive: true });
  // 先清空旧卡片:重渲染若比上次少出卡,残留的旧序号卡会混进发布序列
  // (2026-08-07 实测:重渲染 6 卡,旧 07-card.png 残留)
  try {
    for (const stale of await readdir(outDir)) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(stale)) await rm(join(outDir, stale), { force: true });
    }
  } catch { /* 目录刚创建 */ }

  const { readFile: readFileBuf } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  // about:blank 文档加载 file:// 子资源会被 Chromium 拦截(Not allowed to load
  // local resource),图片统一内联为 data URI
  const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
  const dataUriCache = new Map<string, string>();
  const toUrl = async (p: string): Promise<string> => {
    const cached = dataUriCache.get(p);
    if (cached) return cached;
    const mime = MIME[extname(p).toLowerCase()] ?? "image/png";
    const uri = `data:${mime};base64,${(await readFileBuf(p)).toString("base64")}`;
    dataUriCache.set(p, uri);
    return uri;
  };
  const imageAt = async (i: number): Promise<string | undefined> =>
    images && images.length > 0 ? toUrl(images[i % images.length]) : undefined;

  const jobs: Array<{ html: string; outPath: string }> = [];
  jobs.push({
    html: buildCardHtml({
      spec: layout.cover,
      canvas: layout.canvas,
      kind: "cover",
      title: copy.coverTitle,
      subtitle: copy.coverSubtitle,
      imageUrl: await imageAt(0),
    }),
    outPath: join(outDir, "01-cover.png"),
  });
  for (const [i, p] of copy.pages.entries()) {
    jobs.push({
      html: buildCardHtml({
        spec: layout.content,
        canvas: layout.canvas,
        kind: "content",
        heading: p.heading,
        body: p.body,
        index: i + 1,
        total: copy.pages.length,
        imageUrl: await imageAt(i + 1),
      }),
      outPath: join(outDir, `${String(i + 2).padStart(2, "0")}-card.png`),
    });
  }

  if (render) {
    for (const j of jobs) await render(j.html, j.outPath, layout.canvas);
  } else {
    await renderWithPlaywright(jobs, layout.canvas);
  }

  return { cardsDir: outDir, files: jobs.map((j) => j.outPath) };
}

// ── 图文子作品派生 ───────────────────────────────────────────────────────────

/** 与 work-store.generateId 同格式:w_<yyyyMMdd_HHmm>_<3位hex> */
function generateChildId(): string {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const hex = Math.random().toString(16).slice(2, 5);
  return `w_${ts}_${hex}`;
}

/**
 * 确保父作品有独立的图文子作品（type=image-text, status=reviewing）。
 *
 * 背景（2026-08-07 修复）：双产物作品建库为 short-video + dual_output=1,
 * 图文产物只挂在父作品上,图文发布页(只认 type=image-text)永远没有待审图文。
 * 现在派生时创建独立子作品,拥有自己的 待审核→待发布→已发布 生命周期,
 * 文章/卡片/素材图都复制进子作品目录,发布链路 buildPublishInput 无需特判。
 *
 * 幂等:子作品已存在时 —— 仍在 reviewing 则刷新文章与卡片(打回重做场景);
 * 已 approved/published 则不动(不覆盖用户已确认的图文)。
 */
async function ensureImageTextChild(
  parent: DbWork,
  article: { title: string; content: string; status: string; topic_id?: number },
  deps: DeriveDualOutputsDeps,
): Promise<{ childId: string; cardFiles: string[]; cardsDir?: string } | null> {
  const existing = getChildWorkByParent(parent.id);
  if (existing && existing.status !== "reviewing") {
    log("info", "server", "dual_output_child_exists", parent.id, {
      childId: existing.id, status: existing.status, msg: "子作品已过审,跳过刷新",
    });
    return { childId: existing.id, cardFiles: [] };
  }

  const now = new Date().toISOString();
  const childId = existing?.id ?? generateChildId();

  if (!existing) {
    createWork(
      {
        id: childId,
        title: article.title || `${parent.title}（图文）`,
        type: "image-text",
        status: "reviewing",
        platforms: [],
        evaluation_mode: false,
        tags: parent.tags,
        topic_id: parent.topic_id,
        template_id: parent.template_id,
        dual_output: false,
        parent_work_id: parent.id,
        created_at: now,
        updated_at: now,
      } as DbWork,
      [],
    );
    log("info", "server", "dual_output_child_created", parent.id, { childId });
  }

  // 文章复制到子作品名下(独立编辑,互不影响父作品文章)
  const childArticle = listArticlesByWork(childId)[0];
  if (childArticle) {
    updateArticle(childArticle.id, { title: article.title, content: article.content });
  } else {
    createArticle({
      work_id: childId,
      topic_id: article.topic_id ?? parent.topic_id,
      title: article.title,
      content: article.content,
      status: article.status as import("../db/types.js").DbArticle["status"],
    });
  }

  const childWorkDir = join(dataDir, "works", childId);
  const parentWorkDir = join(dataDir, "works", parent.id);

  // 素材图复制(知乎/公众号正文插图 buildPublishInput.collectContentImages 用)
  const srcImages = join(parentWorkDir, "assets", "images");
  try {
    await cp(srcImages, join(childWorkDir, "assets", "images"), { recursive: true });
  } catch { /* 父作品无素材图,纯文本图文也成立 */ }

  // 收集素材图(卡片「图+文」形态用,绝对路径按文件名排序)
  let materialImages: string[] = [];
  try {
    const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    const entries = await readdir(join(childWorkDir, "assets", "images"));
    materialImages = entries
      .filter((f) => IMG_EXTS.has(f.slice(f.lastIndexOf(".")).toLowerCase()))
      .sort()
      .map((f) => join(childWorkDir, "assets", "images", f));
  } catch { /* 无素材目录 */ }

  // 卡片:仅「新建子作品且父作品已有渲染产物」(存量回填场景)直接复制;
  // 其余(刷新/强制)都重新渲染,避免拿过期的旧文章卡片
  const childCardsDir = join(childWorkDir, "output", "cards");
  const parentCardsDir = join(parentWorkDir, "output", "cards");
  let cardFiles: string[] = [];
  if (!existing && !deps.forceRender) {
    try {
      const parentCards = (await readdir(parentCardsDir)).filter((f) => f.endsWith(".png"));
      if (parentCards.length > 0) {
        await cp(parentCardsDir, childCardsDir, { recursive: true });
        cardFiles = parentCards.sort().map((f) => join(childCardsDir, f));
      }
    } catch { /* 父目录无卡片,走渲染 */ }
  }

  if (cardFiles.length === 0) {
    const layout = resolveCardLayout(parent.template_id);
    const copy = deps.generateCopy
      ? await deps.generateCopy({ title: article.title, content: article.content })
      : await generateCardCopy({ title: article.title, content: article.content });
    if (copy.pages.length === 0) {
      log("warn", "server", "dual_output_empty_card_copy", parent.id, {});
    } else {
      const rendered = await renderCardsToPng(copy, layout, childCardsDir, deps.render, materialImages);
      cardFiles = rendered.files;
      await writeFile(
        join(childCardsDir, "cards.json"),
        JSON.stringify(
          {
            workId: childId,
            parentWorkId: parent.id,
            title: article.title,
            templateId: layout.templateId ?? null,
            generatedAt: now,
            files: rendered.files.map((f) => f.split(/[\\/]/).pop()),
          },
          null,
          2,
        ),
        "utf-8",
      );
    }
  }

  // 公众号草稿封面:由封面卡转出 output/cover.jpg(thumb_media 只收 JPEG;
  // 缺失会导致公众号发布失败 "需要封面图" —— 2026-08-07 实测)
  if (cardFiles.length > 0) {
    const coverPng = cardFiles.find((f) => /01-cover\.png$/i.test(f)) ?? cardFiles[0];
    try {
      await coverPngToJpg(coverPng, join(childWorkDir, "output", "cover.jpg"));
    } catch (err) {
      log("warn", "server", "dual_output_cover_jpg_failed", parent.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { childId, cardFiles, cardsDir: childCardsDir };
}

/**
 * 封面卡 PNG → output/cover.jpg（公众号草稿封面 thumb_media 只收 JPEG）。
 * 无 sharp/canvas 基建,用 Playwright 页内 canvas 转换。
 */
async function coverPngToJpg(pngPath: string, jpgPath: string): Promise<void> {
  const { readFile: readBuf } = await import("node:fs/promises");
  const { chromium } = await import("playwright");
  const b64 = (await readBuf(pngPath)).toString("base64");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const jpgB64 = await page.evaluate(async (src: string) => {
      const img = new Image();
      img.src = `data:image/png;base64,${src}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    }, b64);
    await writeFile(jpgPath, Buffer.from(jpgB64, "base64"));
  } finally {
    await browser.close();
  }
}

// ── 派生主流程 ───────────────────────────────────────────────────────────────

export interface DeriveDualOutputsResult {
  /** 图文文章产物就绪（文章存在，发布链路可获取内容 + 素材图） */
  articleReady: boolean;
  /** 图文子作品 ID（图文发布页待审条目） */
  childWorkId?: string;
  /** 小红书卡片产物（在子作品 output/cards/ 下） */
  cardFiles: string[];
  cardsDir?: string;
}

export interface DeriveDualOutputsDeps {
  generateCopy?: (article: { title: string; content: string }) => Promise<CardCopy>;
  render?: CardRenderer;
  /** 强制重渲染卡片(忽略父作品已有卡片复制快路径),版式/素材策略升级后回填用 */
  forceRender?: boolean;
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

    // 图文子作品的内容来源是父作品文章(批量制作时已写入 articles 表)
    const article = listArticlesByWork(workId)[0];
    if (!article?.content) {
      log("warn", "server", "dual_output_no_article", workId, {
        msg: "双产物作品无文章,无法派生图文子作品",
      });
      return result;
    }
    result.articleReady = true;

    // 派生/刷新独立图文子作品(文章复制 + 卡片渲染 + 素材图复制)
    try {
      const child = await ensureImageTextChild(work, article, deps);
      if (child) {
        result.childWorkId = child.childId;
        result.cardFiles = child.cardFiles;
        result.cardsDir = child.cardsDir;
      }
    } catch (err) {
      log("error", "server", "dual_output_child_failed", workId, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log("info", "server", "dual_output_derived", workId, {
      articleReady: result.articleReady,
      childWorkId: result.childWorkId ?? null,
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
