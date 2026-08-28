/**
 * 模板二次加工(2026-08-13 模板库改造 功能 b)。
 *
 * 用户输入自然语言指令(如"配色改成墨绿""标题字号再大一点"),
 * LLM 在现有模板 JSON 基础上输出修改后的完整模板,校验后写回。
 * 默认覆盖原模板;saveAsCopy 时另存副本(status=draft)。
 *
 * 复用 runJsonPrompt(禁工具、结构化 JSON、自带解析重试);
 * 语义校验(validateTemplate / LayoutSpec 齐全性)失败时带错误信息再重试一次。
 */

import { randomUUID } from "node:crypto";
import { getTemplate, updateTemplate, createTemplate } from "../db/templates-repo.js";
import { runJsonPrompt } from "./llm-json.js";
import { validateTemplate, TimelineValidationError } from "../video/schema.js";
import { LAYOUTS, PALETTES, MOTIONS, DECORATIONS } from "./template-dna.js";
import type { DbTemplate } from "../db/templates-repo.js";

export interface RefineResult {
  templateId: string;
  /** 一句话描述改了什么,供前端提示 */
  diffSummary: string;
  /** true = 另存为新模板 */
  copied: boolean;
}

function templateSchemaGuide(kind: string): string {
  if (kind === "image-text") {
    return [
      "## 图文模板结构(必须保持)",
      "layers 恰好两条:{id:'cover',type:'image-text-layout',page:'cover',layout,font,fontSize,colorScheme:{background,primary,text,accent},decorations[]} 和 {id:'content-page',...,page:'content',...}。",
      "- layout 蛇形命名,参考:" + LAYOUTS.map((o) => o.key).join("/"),
      "- decorations 可选:" + DECORATIONS.map((o) => o.key).join("/"),
      "- 配色全部 #RRGGBB 六位实色;fontSize 封面 72-120,内容页 48-72",
    ].join("\n");
  }
  return [
    "## 视频模板结构(必须保持)",
    "canvas:{width,height,fps,backgroundColor};layers 数组,每层:{id,type(video|image|text|shape),start,duration,position(像素{x,y}或center/top/bottom/left/right),size(视频/图片/形状必填{width,height}),opacity?,animations?}。",
    "- text 层:content/fontSize/color/align/stroke;动画仅 fadein/fadeout/slidein/slideout/scale/rotate(fade/scale/rotate 不可用于 text/shape 层)",
    "- variables 数组:{name,type(text|number|video|image|audio),default?,label?},图层中用 {{name}} 占位",
    "- audio 数组(BGM 等)、transitions 数组(fade/slide/wipe)、subtitles 可选",
    "- 版式参考:" + LAYOUTS.map((o) => o.key).join("/") + ";配色参考:" + PALETTES.map((o) => o.key).join("/") + ";动效参考:" + MOTIONS.map((o) => o.key).join("/"),
  ].join("\n");
}

function buildPrompt(template: DbTemplate, instruction: string, validationError?: string): string {
  return [
    "你是顶级短视频/图文视觉设计师。用户要对一个已有模板做二次加工。",
    "",
    "## 现有模板 JSON",
    JSON.stringify({ name: template.name, canvas: template.canvas, variables: template.variables, layers: template.layers, audio: template.audio, subtitles: template.subtitles, transitions: template.transitions }, null, 2),
    "",
    "## 用户加工指令",
    instruction,
    "",
    templateSchemaGuide(template.kind),
    "",
    "## 要求",
    "1. 只改用户指令涉及的部分,其余保持原样",
    "2. 输出完整的修改后模板(不是 diff)",
    "3. 输出严格 JSON:{\"name\":\"...\",\"canvas\":{...},\"variables\":[...],\"layers\":[...],\"audio\":[...],\"transitions\":[...],\"subtitles\":{...}(可选)}",
    validationError ? `\n⚠️ 上一次输出未通过校验:${validationError}\n请修正后重新输出完整模板。` : "",
  ].filter(Boolean).join("\n");
}

/** 浅比较生成一句话变更摘要 */
function diffSummary(before: DbTemplate, after: Record<string, unknown>): string {
  const parts: string[] = [];
  const bLayers = before.layers?.length ?? 0;
  const aLayers = Array.isArray(after.layers) ? after.layers.length : 0;
  if (bLayers !== aLayers) parts.push(`图层 ${bLayers}→${aLayers}`);
  const bJson = JSON.stringify(before.layers);
  const aJson = JSON.stringify(after.layers ?? []);
  if (bJson !== aJson && bLayers === aLayers) parts.push("图层内容已调整");
  if (JSON.stringify(before.canvas) !== JSON.stringify(after.canvas)) parts.push("画布参数已调整");
  if (after.name && after.name !== before.name) parts.push(`名称改为「${after.name}」`);
  return parts.length ? parts.join(";") : "模板已按指令更新";
}

export async function refineTemplate(
  templateId: string,
  instruction: string,
  saveAsCopy = false,
): Promise<RefineResult> {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`模板不存在: ${templateId}`);
  if (!instruction.trim()) throw new Error("加工指令不能为空");

  // 2026-08-28 批次8.1:code 模版走 TSX 专用 refine 通道——此前落入时间线 validateTemplate
  // 必然失败(template-refine.ts 按时间线校验 TSX,v2 病根 4)
  if (template.kind === "code") {
    return refineCodeTemplate(template, instruction, saveAsCopy);
  }

  let validationError: string | undefined;
  let refined: Record<string, unknown> | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runJsonPrompt<Record<string, unknown>>(
      buildPrompt(template, instruction, validationError),
      { timeoutMs: 300_000 },
    );
    try {
      if (template.kind === "image-text") {
        // 图文:恰好 cover/content 两条 LayoutSpec
        const layers = Array.isArray(result.layers) ? result.layers : [];
        const pages = layers.filter((l: any) => l?.type === "image-text-layout").map((l: any) => l.page);
        if (!pages.includes("cover") || !pages.includes("content")) {
          throw new Error("图文模板 layers 必须包含 page=cover 与 page=content 两条 image-text-layout");
        }
      } else {
        validateTemplate({ id: template.id, ...result });
      }
      refined = result;
      break;
    } catch (err) {
      validationError = err instanceof TimelineValidationError || err instanceof Error ? err.message : String(err);
      if (attempt === 2) throw new Error(`再加工产出未通过校验:${validationError}`);
    }
  }

  if (saveAsCopy) {
    const newId = `tpl_${randomUUID().slice(0, 8)}`;
    createTemplate({
      id: newId,
      name: `${refined!.name ?? template.name}(改版)`,
      content_form: template.content_form,
      canvas: (refined!.canvas ?? template.canvas) as any,
      variables: (refined!.variables ?? template.variables) as any,
      layers: (refined!.layers ?? template.layers) as any,
      audio: (refined!.audio ?? template.audio) as any,
      subtitles: (refined!.subtitles ?? template.subtitles) as any,
      transitions: (refined!.transitions ?? template.transitions) as any,
      status: "draft",
      kind: template.kind,
    } as any);
    return { templateId: newId, diffSummary: diffSummary(template, refined!), copied: true };
  }

  updateTemplate(template.id, {
    name: (refined!.name as string) ?? template.name,
    canvas: refined!.canvas as any,
    variables: refined!.variables as any,
    layers: refined!.layers as any,
    audio: refined!.audio as any,
    subtitles: refined!.subtitles as any,
    transitions: refined!.transitions as any,
  } as any);
  return { templateId: template.id, diffSummary: diffSummary(template, refined!), copied: false };
}

/** 批次8.1:code 模版 TSX 专用 refine 通道。
 *  输出完整 TSX → staticCheckTsx → 试渲染 → 黑屏拦截,两轮不过则报错;
 *  覆盖写回后状态降回 candidate(refine 产物必须重新验证,approved 不豁免) */
async function refineCodeTemplate(
  template: DbTemplate,
  instruction: string,
  saveAsCopy: boolean,
): Promise<RefineResult> {
  const layer0 = (template.layers?.[0] ?? {}) as Record<string, unknown>;
  const currentTsx = String(layer0.customCode ?? "");
  if (!currentTsx) throw new Error(`code 模版 ${template.id} 无 customCode 可加工`);

  const { staticCheckTsx } = await import("./code-template-generator.js");
  const { renderCodeScene } = await import("./code-scene.js");
  const { blackSegments } = await import("./quality-gate.js");

  let lastError = "";
  let tsx = "";
  let name = template.name;
  let passed = false;
  for (let round = 1; round <= 2; round++) {
    const result = await runJsonPrompt<{ name?: string; tsx?: string }>(
      [
        "你是 Revideo 场景代码工程师。用户要对一个已有代码模版的 TSX 场景做二次加工。",
        "",
        "## 现有 TSX 源码",
        "```tsx",
        currentTsx,
        "```",
        "",
        "## 用户加工指令",
        instruction,
        "",
        "## 要求",
        "1. 只改用户指令涉及的部分,其余保持原样;保持 export default function + makeScene2D 结构",
        "2. 禁止使用 fetch/document/window/setTimeout/setInterval/Math.random/while(true)",
        '3. 输出严格 JSON: {"name": "模版名(不改则同前)", "tsx": "完整修改后 TSX 源码"}',
        lastError ? `\n⚠️ 上一次输出未通过校验/渲染:${lastError}\n请修正后重新输出完整 TSX。` : "",
      ].filter(Boolean).join("\n"),
      { stage: "plan", timeoutMs: 300_000, maxAttempts: 2 },
    );
    tsx = result.tsx ?? "";
    if (result.name) name = result.name;
    const staticErrors = staticCheckTsx(tsx);
    if (staticErrors.length) { lastError = `静态检查未过: ${staticErrors.join("; ")}`; continue; }
    const preview = await renderCodeScene({
      workId: "tpl_refine",
      filename: `refine_${randomUUID().slice(0, 8)}`,
      customScene: tsx,
      params: {},
      duration: 5,
    });
    if (!preview.success || !preview.path) { lastError = `试渲染失败: ${preview.error ?? "未知"}`; continue; }
    const blacks = await blackSegments(preview.path);
    if (blacks.length) { lastError = `试渲染黑屏(${blacks[0]})——加工后必须渲染出真实可见内容`; continue; }
    passed = true;
    break;
  }
  if (!passed) {
    throw new Error(`code 模版再加工失败(2 轮后仍未通过): ${lastError || "未产出有效 TSX"}`);
  }

  const newLayers = [{ ...layer0, customCode: tsx }] as any;
  if (saveAsCopy) {
    const newId = `tpl_${randomUUID().slice(0, 8)}`;
    createTemplate({
      id: newId, name: `${name}(改版)`, content_form: template.content_form,
      canvas: template.canvas, variables: template.variables, layers: newLayers,
      audio: template.audio, subtitles: template.subtitles, transitions: template.transitions,
      status: "candidate", kind: "code",
    } as any);
    return { templateId: newId, diffSummary: "TSX 场景已按指令加工(另存副本,待验证转正)", copied: true };
  }
  updateTemplate(template.id, { name, layers: newLayers, status: "candidate" } as any);
  return { templateId: template.id, diffSummary: "TSX 场景已按指令加工并通过试渲染(状态降回 candidate 待验证)", copied: false };
}
