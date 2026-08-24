import { getDb } from "./connection.js";
import { fromJson, toJson } from "./json.js";

export type TemplateStatus = "draft" | "candidate" | "approved" | "archived";

/** 模板类别：video = 视频时间线模板（默认）；image-text = 图文版式模板；code = 代码渲染整片模板(Revideo,2026-08-24) */
export type TemplateKind = "video" | "image-text" | "code";

export interface TemplateVariable {
  name: string;
  type: "text" | "image" | "video" | "audio" | "number" | "color";
  default?: string | number;
  label?: string;
}

export interface TemplateCanvas {
  width: number;
  height: number;
  fps: number;
  backgroundColor?: string;
}

/** 模板级品牌 logo(2026-08-13 模板库改造 功能 c):视频/图文双链路共用 */
export interface TemplateBranding {
  /** 共享素材相对路径,如 "branding/logo.png" */
  logoAsset: string;
  /** 九宫格位置 */
  position: "top-left" | "top-center" | "top-right" | "middle-left" | "center" | "middle-right" | "bottom-left" | "bottom-center" | "bottom-right";
  /** 边距 px,默认 48 */
  margin?: number;
  /** 宽度 px(高度按比例),默认 160 */
  width?: number;
  /** 不透明度 0-1,默认 1 */
  opacity?: number;
}

export const BRANDING_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;

/** 校验/规范化前端提交的 branding;非法输入返回 undefined(不阻断模板保存) */
export function sanitizeBranding(raw: unknown): TemplateBranding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (typeof b.logoAsset !== "string" || !b.logoAsset) return undefined;
  return {
    logoAsset: b.logoAsset,
    position: (BRANDING_POSITIONS as readonly string[]).includes(b.position as string)
      ? (b.position as TemplateBranding["position"])
      : "top-right",
    margin: typeof b.margin === "number" && b.margin >= 0 ? b.margin : 48,
    width: typeof b.width === "number" && b.width > 0 ? b.width : 160,
    opacity: typeof b.opacity === "number" ? Math.max(0, Math.min(1, b.opacity)) : 1,
  };
}

export interface DbTemplate {
  id: string;
  name: string;
  content_form?: string;
  canvas: TemplateCanvas;
  variables: TemplateVariable[];
  layers: Record<string, unknown>[];
  audio: Record<string, unknown>[];
  subtitles?: Record<string, unknown>;
  transitions: Record<string, unknown>[];
  branding?: TemplateBranding;
  preview_url?: string;
  status: TemplateStatus;
  kind: TemplateKind;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

function normalizeLayer(layer: Record<string, unknown>, i: number): Record<string, unknown> {
  const l = { ...layer };
  if (!l.id || typeof l.id !== "string") l.id = `layer_${i}`;
  if (typeof l.start !== "number") l.start = 0;
  if (typeof l.duration !== "number") l.duration = 10;
  if (!l.position) l.position = { x: 0, y: 0 };
  else if (typeof l.position === "string") {
    // 方位词是合法 position(renderer.resolvePosition 支持),此前被一律归零,
    // 导致克隆模板的 "bottom" 字幕层渲染到左上角(2026-08-13 踩坑)
    if (!["center", "top", "bottom", "left", "right"].includes(l.position)) l.position = { x: 0, y: 0 };
  } else if (typeof l.position === "object") {
    const pos = l.position as Record<string, unknown>;
    if (typeof pos.x !== "number") pos.x = 0;
    if (typeof pos.y !== "number") pos.y = 0;
  }
  if (l.type === "text") {
    if (!l.content && l.text) l.content = l.text;
    if (!l.content) l.content = "";
    const style = l.style as Record<string, unknown> | undefined;
    if (style) {
      if (style.fontSize && !l.fontSize) l.fontSize = style.fontSize;
      if (style.color && !l.color) l.color = style.color;
      if (style.align && !l.align) l.align = style.align;
      delete l.style;
    }
    if (typeof l.fontSize !== "number") l.fontSize = 40;
    if (!l.color) l.color = "#FFFFFF";
    if (!l.align) l.align = "left";
  }
  if (l.type === "shape") {
    if (!l.shape) l.shape = "rect";
    if (!l.fill && l.color) l.fill = l.color;
    if (!l.fill) l.fill = "#FFFFFF";
    if (!l.size || typeof l.size !== "object") l.size = { width: 100, height: 100 };
    else {
      const sz = l.size as Record<string, unknown>;
      if (typeof sz.width !== "number") sz.width = 100;
      if (typeof sz.height !== "number") sz.height = 100;
    }
    delete l.color;
  }
  return l;
}

function rowToTemplate(row: Record<string, unknown>): DbTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    content_form: (row.content_form as string) || undefined,
    canvas: (() => {
      const c = fromJson(row.canvas as string) as TemplateCanvas;
      if (typeof c.width !== 'number') c.width = 1080;
      if (typeof c.height !== 'number') c.height = 1920;
      if (typeof c.fps !== 'number') c.fps = 30;
      if (!c.backgroundColor) c.backgroundColor = '#0a0a0a';
      return c;
    })(),
    variables: fromJson(row.variables as string) as TemplateVariable[],
    layers: (fromJson(row.layers as string) as Record<string, unknown>[] ?? []).map(normalizeLayer),
    audio: fromJson(row.audio as string) as Record<string, unknown>[],
    subtitles: row.subtitles ? fromJson(row.subtitles as string) as Record<string, unknown> | undefined : undefined,
    transitions: fromJson(row.transitions as string) as Record<string, unknown>[],
    branding: row.branding ? fromJson(row.branding as string) as TemplateBranding : undefined,
    preview_url: (row.preview_url as string) || undefined,
    status: row.status as TemplateStatus,
    kind: (row.kind as TemplateKind) || "video",
    usage_count: (row.usage_count as number) ?? 0,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createTemplate(template: Omit<DbTemplate, "created_at" | "updated_at" | "usage_count" | "kind"> & { usage_count?: number; kind?: TemplateKind }): DbTemplate {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO templates (id, name, content_form, canvas, variables, layers, audio, subtitles, transitions, branding, preview_url, status, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    template.id,
    template.name,
    template.content_form ?? null,
    toJson(template.canvas),
    toJson(template.variables),
    toJson(template.layers),
    toJson(template.audio),
    template.subtitles ? toJson(template.subtitles) : null,
    toJson(template.transitions),
    template.branding ? toJson(template.branding) : null,
    template.preview_url ?? null,
    template.status,
    template.kind ?? "video",
    now,
    now
  );
  return { ...template, kind: template.kind ?? "video", usage_count: template.usage_count ?? 0, created_at: now, updated_at: now };
}

export function getTemplate(id: string): DbTemplate | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTemplate(row) : undefined;
}

export function listTemplates(status?: TemplateStatus, contentForm?: string, kind?: TemplateKind, limit = 100): DbTemplate[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (contentForm) { clauses.push("content_form = ?"); params.push(contentForm); }
  if (kind) { clauses.push("kind = ?"); params.push(kind); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM templates ${where} ORDER BY updated_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToTemplate);
}

export function updateTemplate(id: string, updates: Partial<DbTemplate>): DbTemplate | undefined {
  const db = getDb();
  return db.transaction(() => {
    const existing = getTemplate(id);
    if (!existing) return undefined;
    const template: DbTemplate = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE templates SET
        name = ?, content_form = ?, canvas = ?, variables = ?, layers = ?, audio = ?, subtitles = ?,
        transitions = ?, branding = ?, preview_url = ?, status = ?, kind = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      template.name,
      template.content_form ?? null,
      toJson(template.canvas),
      toJson(template.variables),
      toJson(template.layers),
      toJson(template.audio),
      template.subtitles ? toJson(template.subtitles) : null,
      toJson(template.transitions),
      template.branding ? toJson(template.branding) : null,
      template.preview_url ?? null,
      template.status,
      template.kind ?? "video",
      template.updated_at,
      id
    );
    return template;
  })();
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  return result.changes > 0;
}

/** 渲染使用一次模板即 +1（自进化信号：高频模板的要素组合会在生成时被优先参考） */
export function incrementTemplateUsage(id: string): void {
  const db = getDb();
  db.prepare("UPDATE templates SET usage_count = usage_count + 1 WHERE id = ?").run(id);
}

/** 使用频次最高的模板（生成 prompt 的偏好信号来源） */
export function listTopUsedTemplates(limit = 5): DbTemplate[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM templates WHERE usage_count > 0 ORDER BY usage_count DESC, updated_at DESC LIMIT ?"
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToTemplate);
}
