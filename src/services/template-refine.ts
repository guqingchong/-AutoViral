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
import { join } from "node:path";
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

/**
 * 再加工指令分流(2026-09-07,架构改造层3):不同指令类型的能力需求完全不同——
 * 参数微调快模型单发即可;结构新增(手写 SVG 几何)超出快模型能力,需强模型+视觉回译循环;
 * 整体重做应走重新生成而非再加工。规则判定,零 LLM 成本。
 */
export function classifyRefineInstruction(instruction: string): "param" | "structural" | "redo" {
  const t = instruction;
  if (/重做|重新生成|全换|整体重来|推倒/.test(t)) return "redo";
  // 结构新增:涉及场景底板/几何元素/立体材质类(实测"舱门底板"类指令快模型两轮画不出)
  if (/底板|舱门|舷窗|操作台|控制台|背景板|新增|添加|加上|装置|结构|元素|场景|纹理|材质|立体|发光|占位|卡片|模块|图标/.test(t)) return "structural";
  return "param";
}

/**
 * refine 保真门禁(2026-09-07 初版)→ 视觉回译(同日架构升级):
 * 不仅判定"指令是否体现",还把"画面实际有什么"用自然语言回译给代码模型——
 * 代码模型自己看不见渲染结果,回译文本是它的眼睛(模拟人工"抽帧看效果"的回路)。
 * 返回 null=通过或通道不可用(放行,warn);否则返回差距清单+画面描述,进修复循环。
 */
async function checkRefineFidelity(
  previewPath: string,
  instruction: string,
): Promise<{ missing: string[]; sceneDesc: string } | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdir } = await import("node:fs/promises");
    const { dataDir } = await import("../config.js");
    const execFileAsync = promisify(execFile);
    const frameDir = join(dataDir, "tmp");
    await mkdir(frameDir, { recursive: true });
    // 抽两帧:前段(封面/开场) + 中段(正文)——单帧抽查曾漏掉分页模板的封面页
    const frames: string[] = [];
    for (const [i, t] of [0.3, 2.5].entries()) {
      const fp = join(frameDir, `refine_fidelity_${randomUUID().slice(0, 8)}_${i}.png`);
      await execFileAsync("ffmpeg", ["-ss", String(t), "-i", previewPath, "-frames:v", "1", "-y", fp], { timeout: 30_000 });
      frames.push(fp);
    }
    const { loadConfig } = await import("../config.js");
    const { chatVisionJson } = await import("../llm/vision-json.js");
    const r = await chatVisionJson<{ implemented?: boolean; missing?: string[]; scene?: string }>(
      await loadConfig(),
      frames,
      [
        "你是模板加工验收员。用户对模板发出的加工指令如下:",
        `「${instruction}」`,
        "附图为加工后模板渲染的两个关键帧(图1=开场/封面,图2=正文)。做两件事:",
        "1. scene:用 2-3 句话客观描述每帧画面实际有什么(构图/元素/材质/文字),不要评价好坏;",
        "2. 逐条判断指令中的视觉要求是否真实体现(如要求'舱门底板',画面必须出现舱门/舷窗类几何结构——只改配色/渐变/阴影不算体现)。",
        '输出 JSON: {"scene": "画面描述", "implemented": true|false, "missing": ["未体现的要求", ...]}',
      ].join("\n"),
      { timeoutMs: 90_000 },
    );
    if (r?.implemented === false) {
      return {
        missing: r.missing?.length ? r.missing : ["指令要求的视觉元素未体现"],
        sceneDesc: r.scene ?? "",
      };
    }
    return null;
  } catch (err) {
    console.warn("[template-refine] fidelity/回译通道不可用,放行(不阻断):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 批次8.1:code 模版 TSX 专用 refine 通道。
 *  输出完整 TSX → staticCheckTsx → 试渲染 → 黑屏拦截,两轮不过则报错;
 *  覆盖写回后状态降回 candidate(refine 产物必须重新验证,approved 不豁免)
 *  2026-09-02:customHtml(web 支路整片)优先于 customCode,走 HTML 契约校验 */
async function refineCodeTemplate(
  template: DbTemplate,
  instruction: string,
  saveAsCopy: boolean,
): Promise<RefineResult> {
  const layer0 = (template.layers?.[0] ?? {}) as Record<string, unknown>;
  const currentHtml = String(layer0.customHtml ?? "");
  const currentTsx = String(layer0.customCode ?? "");
  if (!currentHtml && !currentTsx) throw new Error(`code 模版 ${template.id} 无 customCode/customHtml 可加工`);
  const isWeb = !!currentHtml;
  const currentCode = isWeb ? currentHtml : currentTsx;

  const { staticCheckTsx } = await import("./code-template-generator.js");
  const { staticCheckHtml } = await import("./scene-template-generator.js");
  const { renderCodeScene } = await import("./code-scene.js");
  const { blackSegments } = await import("./quality-gate.js");

  let lastError = "";
  let code = "";
  let name = template.name;
  let passed = false;
  let passedPreviewPath = "";
  // 试渲染画幅必须跟随模板画布(2026-09-02:横屏模板此前按默认竖屏试渲染,
  // 黑屏门禁/预览都可能误判)
  const size = { w: (template.canvas as { width?: number })?.width ?? 1080, h: (template.canvas as { height?: number })?.height ?? 1920 };
  // 指令分流(2026-09-07 架构改造层3):整体重做引导去重新生成;结构新增走强模型
  // 通道 + 最多 4 轮视觉回译打磨;参数微调走默认 plan 档 2 轮。
  const instructionClass = classifyRefineInstruction(instruction);
  if (instructionClass === "redo") {
    throw new Error("该指令属于整体重做——再加工适合局部调整。请到模板库用「生成」重新做一版,或把指令拆成局部调整(先改底板、再改字体)");
  }
  const maxRounds = instructionClass === "structural" ? 4 : 2;
  const llmOpts = {
    stage: "plan" as const,
    timeoutMs: 480_000,
    maxAttempts: 2,
    fallbackStage: "assets" as const,
    maxTokens: 65536,
    // 结构新增:快模型实测两轮画不出舱门级几何(deepseek-v4-flash 局限),
    // 走强模型通道 kimi-for-coding(编码长输出能力档)
    ...(instructionClass === "structural" ? { forceModel: "kimi:kimi-for-coding" } : {}),
  };
  /** 视觉回译:上一轮产出的画面客观描述(层2——代码模型看不见渲染结果,回译文本是它的眼睛) */
  let sceneDesc = "";
  for (let round = 1; round <= maxRounds; round++) {
    const result = await runJsonPrompt<{ name?: string; tsx?: string; html?: string }>(
      [
        isWeb
          ? "你是前端动画工程师。用户要对一个已有代码模版的整片 HTML 场景做二次加工。"
          : "你是 Revideo 场景代码工程师。用户要对一个已有代码模版的 TSX 场景做二次加工。",
        "",
        isWeb ? "## 现有 HTML 源码" : "## 现有 TSX 源码",
        isWeb ? "```html" : "```tsx",
        currentCode,
        "```",
        "",
        "## 用户加工指令",
        instruction,
        "",
        "## 要求",
        instructionClass === "structural" && isWeb
          ? "1. 本指令涉及场景元素新增/替换——必须真实手写对应的 SVG/CSS 几何结构(如舱门=门框+舷窗+铆钉的 SVG 组合),只改颜色/渐变/阴影不算完成;指令未涉及的部分保持原样;保持自包含单文件 + theme-vars 注入 + WAAPI fill:'both' + __seek 挂钩结构"
          : isWeb
            ? "1. 只改用户指令涉及的部分,其余保持原样;保持自包含单文件 + theme-vars 注入 + WAAPI fill:'both' + __seek 挂钩结构"
            : "1. 只改用户指令涉及的部分,其余保持原样;保持 export default function + makeScene2D 结构",
        isWeb
          ? "2. 禁止外链/fetch/定时器/rAF/Math.random;WebGL 绘制必须在 __seek 内置 u_time;若指令涉及写实场景底板(照片级舱门/操作台等),代码须支持 __PARAMS__.bgImage 图片槽位(存在时铺满最底层),不硬手写照片级几何"
          : "2. 禁止使用 fetch/document/window/setTimeout/setInterval/Math.random/while(true)",
        isWeb
          ? '3. 输出严格 JSON: {"name": "模版名(不改则同前)", "html": "完整修改后 HTML 源码"}'
          : '3. 输出严格 JSON: {"name": "模版名(不改则同前)", "tsx": "完整修改后 TSX 源码"}',
        lastError ? `\n⚠️ 上一次输出未通过校验/渲染:${lastError}\n请修正后重新输出完整代码。` : "",
        // 层2 视觉回译(2026-09-07):把上一轮产物的真实画面描述喂回——
        // 代码模型自己看不见渲染结果,这是它唯一能"看到"自己作品的机会
        sceneDesc
          ? `\n## 你上一轮的产出实际渲染成了这样(视觉回译,客观描述)\n${sceneDesc}\n对照指令要求,你的上一版缺什么一目了然——这次必须真实画出指令要求的结构。`
          : "",
        // 结构写法词汇(保真打回时给,降低手写几何的实现难度)
        /未体现指令要求/.test(lastError)
          ? "\n## 常见结构写法参考(按指令选用)\n" +
            "- 舱门底板: <svg> 大圆环(两个同心 circle 描边,外圈 12-16 个铆钉小 circle 绕圆周阵列) + 内门板(rect/大圆填充深色金属渐变) + 中心舷窗(圆+内描边,窗内点几颗星点)\n" +
            "- 操作台底板: 底部梯形台体(polygon) + 2-4 个小屏幕(rect 深色底+顶部一条扫描线) + 按钮行(一排小 circle/rect) + 弧形仪表(path 圆弧+指针 line)\n" +
            "- 金属质感: 元素用 linearGradient(45deg, #3a4a55, #1a242e) 填充 + 1-2px 浅色描边 + 外发光 filter:url(#glow)\n" +
            "- 立体线框: 双层描边(外 3px 深色 + 内 1px 亮色错位 2px) + border-radius 圆角"
          : "",
      ].filter(Boolean).join("\n"),
      llmOpts,
    );
    code = (isWeb ? result.html : result.tsx) ?? "";
    if (result.name) name = result.name;
    const staticErrors = isWeb ? staticCheckHtml(code) : staticCheckTsx(code);
    if (staticErrors.length) { lastError = `静态检查未过: ${staticErrors.join("; ")}`; continue; }
    const preview = await renderCodeScene({
      workId: "tpl_refine",
      filename: `refine_${randomUUID().slice(0, 8)}`,
      ...(isWeb ? { customHtml: code } : { customScene: code }),
      // 2026-09-02:试渲染带示例文案——此前 params:{} 空跑,模板回退默认值,
      // 预览标题全显示"预览"二字,用户无法判断排版/字号效果
      params: { title: "预览标题示例", kicker: "PREVIEW", subtitleCn: "中文字幕预览效果", subtitleEn: "English subtitle preview" },
      duration: 5,
      size,
    });
    if (!preview.success || !preview.path) { lastError = `试渲染失败: ${preview.error ?? "未知"}`; continue; }
    const blacks = await blackSegments(preview.path);
    if (blacks.length) { lastError = `试渲染黑屏(${blacks[0]})——加工后必须渲染出真实可见内容`; continue; }
    // 2026-09-07:refine 保真门禁 + 视觉回译(实测事故:用户"舱门/操作台底板"指令被无视,
    // 模型只调渐变配色也全绿通过)。打回时把差距清单与画面回译一起带入下一轮
    if (isWeb) {
      const fidelity = await checkRefineFidelity(preview.path, instruction);
      if (fidelity) {
        lastError = `加工结果未体现指令要求: ${fidelity.missing.join("、")}——必须新增真实可见的对应视觉元素(SVG/CSS 几何结构),只调整配色/渐变/阴影不算完成`;
        if (fidelity.sceneDesc) sceneDesc = fidelity.sceneDesc;
        continue;
      }
    }
    passed = true;
    passedPreviewPath = preview.path;
    break;
  }
  if (!passed) {
    throw new Error(`code 模版再加工失败(${maxRounds} 轮后仍未通过): ${lastError || "未产出有效代码"}`);
  }

  // 2026-09-02 修复:再加工成功后同步刷新预览产物——此前 preview_url/poster 仍指向
  // 生成时的旧渲染,用户看到"加工完成但预览没有任何变化"(本次事故根因)。
  // 试渲染产物就是新代码的真实渲染,直接归位复用,不二次渲染。
  const targetId = saveAsCopy ? `tpl_${randomUUID().slice(0, 8)}` : template.id;
  try {
    const { dataDir } = await import("../config.js");
    const { copyFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(dataDir, "templates"), { recursive: true });
    const dest = join(dataDir, "templates", `${targetId}-preview.mp4`);
    await copyFile(passedPreviewPath, dest);
    // poster 中帧同步刷新(编辑器/卡片 <video poster>)
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const tplDir = join(dataDir, "templates", targetId);
      await mkdir(tplDir, { recursive: true });
      await promisify(execFile)("ffmpeg", ["-ss", "2.5", "-i", dest, "-frames:v", "1", "-y", join(tplDir, "poster.png")], { timeout: 10_000 });
    } catch { /* poster 失败不阻断 */ }
  } catch { /* 预览归位失败不阻断加工结果 */ }

  const newLayers = [{ ...layer0, ...(isWeb ? { customHtml: code } : { customCode: code }) }] as any;
  if (saveAsCopy) {
    createTemplate({
      id: targetId, name: `${name}(改版)`, content_form: template.content_form,
      canvas: template.canvas, variables: template.variables, layers: newLayers,
      audio: template.audio, subtitles: template.subtitles, transitions: template.transitions,
      status: "candidate", kind: "code",
      preview_url: `/api/templates/${targetId}/preview-file`,
    } as any);
    return { templateId: targetId, diffSummary: `${isWeb ? "HTML" : "TSX"} 场景已按指令加工(另存副本,待验证转正)`, copied: true };
  }
  updateTemplate(template.id, { name, layers: newLayers, status: "candidate" } as any);
  return { templateId: template.id, diffSummary: `${isWeb ? "HTML" : "TSX"} 场景已按指令加工并通过试渲染,预览已同步刷新(状态降回 candidate 待验证)`, copied: false };
}
