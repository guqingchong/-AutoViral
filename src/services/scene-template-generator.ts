/**
 * 镜头模板生成器(2026-09-02 专属生成渠道)。
 *
 * 与 code-template-generator.ts(Revideo TSX 整片)平行的第三条生成支路:
 * LLM 按 templates-web 契约产出自包含 HTML 程序化动画 → 真实渲染 4s 样片验证
 * (web-worker 截帧)→ 黑屏拦截 → 失败带原因定点修复(≤2 轮)→
 * 写入 packages/code-scene/templates-web/<name>.html 并登记 registry.json。
 *
 * 为什么独立成支路:镜头模板是代码资产(HTML 文件 + 注册表),不入 templates 表;
 * 其渲染栈(完整 CSS + WAAPI)是三条支路中表达力最强的,设计稿向导复用同一
 * DesignBrief,但代码纪律完全不同(WAAPI/__seek/主题令牌/字幕带避让)。
 */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runJsonPrompt } from "./llm-json.js";
import { renderCodeScene, registerSceneTemplate, WEB_TEMPLATES, loadSceneRegistry, type SceneRegistryEntry } from "./code-scene.js";
import { blackSegments } from "./quality-gate.js";
import type { DesignBrief } from "./design-brief.js";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "code-scene");

export interface GenerateSceneTemplateInput {
  /** 风格自由描述,如 "数据仪表盘风、深色底、绿色强调" */
  style: string;
  /** 画幅:portrait 1080×1920(默认) | landscape 1920×1080(模板名自动补 -wide 后缀) */
  orientation?: "portrait" | "landscape";
  /** 已确认的设计意图稿:存在时按稿施工 */
  brief?: DesignBrief;
}

interface LlmSceneTemplateResponse {
  name?: string;
  label?: string;
  paramsDoc?: string;
  bestFor?: string;
  sampleParams?: Record<string, unknown>;
  html?: string;
}

/** 最小骨架:展示全部硬性契约(供 LLM 模仿结构,设计必须原创) */
const SKELETON_EXAMPLE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>模板名 · 中文名</title>
<!-- 渲染器经 addInitScript 注入 window.__THEME_CSS__,必须挂到页首 -->
<style id="theme-vars"></style>
<style>
  html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; }
  body { background: var(--bg, #0f1b2d); font-family: var(--font-display, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif); position: relative; }
  .title { position: absolute; top: 196px; left: 96px; right: 96px; font-size: 64px; font-weight: 700; color: var(--text, #f1f5f9); }
  /* 装饰/主体全部 CSS + 内联 SVG,主题一律 var(--xxx, fallback) */
</style>
</head>
<body>
<div class="title" id="title"></div>
<script>
(function () {
  document.getElementById("theme-vars").textContent = window.__THEME_CSS__ || "";
  var P = window.__PARAMS__ || {};
  var D = typeof P.duration === "number" && isFinite(P.duration) ? P.duration : 6;
  document.getElementById("title").textContent = P.title || "";
  // 动画全部 WAAPI + fill:"both"(确定性截帧,禁 CSS 无限动画/定时器/Math.random)
  var EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
  document.getElementById("title").animate(
    [{ opacity: 0, transform: "translateY(36px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 600, delay: 150, easing: EASE, fill: "both" });
  // 动态文本/计数挂 __seek(t秒),渲染器逐帧调用,必须确定性
  window.__seek = function (t) { /* 按 t 更新动态内容 */ };
  window.__seek(0);
})();
</script>
</body>
</html>`;

/** 生成 prompt(导出供单测断言契约不丢失) */
export function buildSceneTemplatePrompt(input: GenerateSceneTemplateInput): string {
  const wide = input.orientation === "landscape";
  const W = wide ? 1920 : 1080;
  const H = wide ? 1080 : 1920;
  return [
    "你是顶级动态视觉设计师 + 前端动画工程师,为短视频设计「单镜头程序化动画模板」(web 渲染支路)。",
    "产物是一个 4-8s 的信息镜头(结构图/流程/对比/榜单/金句这类版式之外的原创场景),不是整片。",
    input.brief
      ? [
          "你必须严格实现以下已确认设计稿(DesignBrief)——palette 逐色落实 hex 与用途、",
          "layout 逐区落实内容与位置、motion 逐条落实入场错峰与循环;",
          "elements 是装饰白名单:只允许出现清单内的装饰,禁止添加稿外元素。",
          `设计稿 JSON:\n${JSON.stringify(input.brief, null, 2)}`,
        ].join("\n")
      : `设计需求:${input.style}`,
    "",
    `## 画布:${W}×${H}(html/body 固定像素,overflow hidden)`,
    "",
    "## 输出 JSON(html 放在字符串字段)",
    '{"name":"英文kebab-case≤24字符' + (wide ? ',必须以 -wide 结尾' : ',禁止 -wide 后缀') + '","label":"中文名≤8字","paramsDoc":"参数摘要,如 title, steps[2-5]{title,desc?}","bestFor":"适用场景一句话","sampleParams":{...},"html":"完整 HTML 源码"}',
    "⚠️ 代码必须紧凑:不写注释、不留多余空行,html ≤40KB——超长输出的生成时长会触网网关超时(504),直接被拒收",
    "",
    "## sampleParams 纪律",
    "1. 必须能通过运行时校验:title 必填且 ≤12 字(quote 型模板用 quote ≤60 字替代 title)",
    "2. 数组型参数给 3-4 个元素;所有文案用财经/政策领域示例,有质感",
    "",
    "## HTML 硬性契约(违反任何一条渲染必挂或截帧错乱,将被拒收)",
    "1. 完全自包含单文件 ≤200KB:禁止任何外链——无 <script src>、无 <link>、无图片/字体 URL、",
    "   无 fetch/XHR/sendBeacon/window.open/location 跳转;装饰全部 CSS + 内联 SVG",
    "2. <style id=\"theme-vars\"></style> 必须放页首,脚本第一行注入 window.__THEME_CSS__;",
    "   配色一律 var(--bg/--text/--text-sub/--accent/--accent-2, 带 fallback 实色),禁止写死全篇颜色",
    "3. 动画全部 WAAPI:element.animate(keyframes, {duration, delay, easing, fill:'both'});",
    "   禁止 CSS animation/transition 无限循环、setTimeout/setInterval、requestAnimationFrame 驱动、Math.random",
    "   (渲染器逐帧 seek 截帧,一切必须时间确定性)",
    "4. 动态文本(计数器/当前步等)挂 window.__seek = function(t){...},t 单位秒,确定性输出;",
    "   定义后立即 __seek(0) 初始化",
    "5. 时长自适应:从 window.__PARAMS__.duration 读取目标时长排时间轴;入场全部落定 ≤2s,",
    "   尾帧必须是完整信息态(所有元素 opacity 1,供 tpad 定格)",
    wide
      ? "6. 字幕带避让(横屏):内容下缘不超过 y=880(字幕带 900-1000)"
      : "6. 字幕带避让(竖屏):任何内容禁入 y∈[1418,1562];主体内容集中在 y 300-1400",
    "7. 字号阶梯:主标题 56-72px(横屏)/48-64px(竖屏),辅助 ≥24px;苹果式少即是多,单一视觉重心",
    "",
    "## 材质纪律(L4/L5,2026-09-02 渲染能力升级):拒绝平面色块堆砌",
    "8. SVG 滤镜(内联 <svg> 承载,position:absolute;inset:0):背景颗粒/纸纹/湍流用 feTurbulence,",
    "   辉光层次用 feGaussianBlur 叠层,整体调色用 feColorMatrix,边缘扰动用 feDisplacementMap",
    "9. 混合模式与遮罩:光效/氛围层用 mix-blend-mode(screen/overlay/soft-light),",
    "   聚光开孔/渐隐边缘用 CSS mask(radial-gradient/conic-gradient 合成),避免生硬矩形边界",
    "10. L5 WebGL 子类(可选,仅当需求含粒子/流体/3D/体积光时启用):单个 <canvas> + 原生 WebGL2,",
    "    禁任何库;硬性规则:",
    "    - getContext('webgl2', { preserveDrawingBuffer: true })",
    "    - 一切渲染在 window.__seek(t) 内完成:置 uniform u_time=t 后同步 gl.draw*,禁止 rAF 驱动",
    "    - 着色器内联为 JS 字符串;uniform 仅限 u_time/u_resolution 及 __PARAMS__ 派生值",
    "    - 文字(title/kicker 等)仍在 canvas 之上用 DOM 排版,保证字体渲染与清晰度",
    "",
    "## 参考骨架(学契约,不抄设计)",
    "```html",
    SKELETON_EXAMPLE,
    "```",
  ].join("\n");
}

/** 渲染前静态检查(导出供单测);与 code-scene.validateCodeSceneInput 的 customHtml 黑名单保持一致 */
export function staticCheckHtml(html: string): string[] {
  const errors: string[] = [];
  if (html.length > 200_000) errors.push(`html ≤200KB(当前 ${Math.round(html.length / 1024)}KB)`);
  if (!/<\s*(html|!doctype)/i.test(html)) errors.push("须为完整 HTML 文档");
  if (!/<style\s+id=["']theme-vars["']/.test(html)) errors.push('缺少 <style id="theme-vars"> 主题注入位');
  if (!/window\.__THEME_CSS__/.test(html)) errors.push("缺少 window.__THEME_CSS__ 注入");
  if (!/window\.__seek\s*=/.test(html)) errors.push("缺少 window.__seek 确定性 seek 挂钩");
  if (!/\.animate\s*\(/.test(html) && !/getContext\(\s*["']webgl/.test(html)) {
    errors.push("未发现 WAAPI element.animate 动画或 WebGL 渲染上下文(至少其一)");
  }
  if (!/window\.__PARAMS__/.test(html)) errors.push("未读取 window.__PARAMS__ 参数");
  const banned = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /<script[^>]*\bsrc\s*=/i, /https?:\/\//i, /\bwindow\.open\s*\(/, /\blocation\s*(?:\.href\s*)?=/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /Math\.random\s*\(/, /requestAnimationFrame\s*\(/];
  const hit = banned.find((re) => re.test(html));
  if (hit) errors.push(`含禁止模式(${hit.source})——模板必须自包含且时间确定`);
  return errors;
}

/** 模板名规范化:小写 kebab;横屏强制 -wide 后缀(doRender 的 isWide 判定依赖它) */
export function normalizeSceneName(raw: string, orientation: "portrait" | "landscape"): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  if (!name) throw new Error("LLM 未给出合法模板名");
  if (orientation === "landscape" && !name.endsWith("-wide")) name = `${name}-wide`;
  if (orientation === "portrait" && name.endsWith("-wide")) name = name.slice(0, -5);
  return name;
}

/**
 * 生成一个镜头模板:LLM 产 HTML → 静态检查 → 真实渲染 4s 验证 → 黑屏拦截 →
 * 失败定点修复(≤2 轮)→ 写 templates-web/ + registry.json。返回注册的目录条目。
 */
export async function generateSceneTemplate(input: GenerateSceneTemplateInput): Promise<SceneRegistryEntry> {
  if (!input.style?.trim() && !input.brief) throw new Error("style 必填");
  const orientation = input.orientation ?? "portrait";
  const size = orientation === "landscape" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };
  const style = input.style?.trim() || input.brief?.styleSummary || input.brief?.sourceText || "镜头模板";

  const prompt = buildSceneTemplatePrompt({ ...input, style, orientation });
  let draft = await runJsonPrompt<LlmSceneTemplateResponse>(prompt, {
    stage: "plan",
    timeoutMs: 600_000,
    maxAttempts: 2,
    fallbackStage: "assets", // kimi 网关 504 时回退 deepseek(2026-09-02 事故);主档 2 次即回退,不在抖动服务上空烧
  });

  let lastError = "";
  for (let round = 0; round <= 2; round++) {
    const html = draft.html ?? "";
    const staticErrors = staticCheckHtml(html);
    if (staticErrors.length === 0) {
      // 渲染验证:与创作期 customHtml 同路径(web-worker),产物留 tpl_codegen 伪作品
      const preview = await renderCodeScene({
        workId: "tpl_codegen",
        filename: `scene_${randomUUID().slice(0, 8)}`,
        customHtml: html,
        params: { ...(draft.sampleParams ?? {}), duration: 4 },
        duration: 4,
        size,
      });
      if (preview.success && preview.path) {
        const blacks = await blackSegments(preview.path);
        if (blacks.length === 0) {
          return await saveSceneTemplate(draft, html, orientation);
        }
        lastError = `预览可渲染但画面黑屏/纯色(${blacks[0]})——模板必须渲染出真实可见内容:检查元素尺寸/坐标/颜色对比度/初始 opacity`;
      } else {
        lastError = preview.error ?? "渲染失败(无错误信息)";
      }
    } else {
      lastError = `静态检查未过: ${staticErrors.join("; ")}`;
    }
    if (round === 2) break;
    console.warn(`[scene-template-gen] round ${round + 1} 未过,定点修复: ${lastError.slice(0, 200)}`);
    draft = await runJsonPrompt<LlmSceneTemplateResponse>(
      [
        "你是前端动画修复师。下面这份镜头模板 HTML 未通过验收,请定点修复后输出完整修复版。",
        "保持设计意图与参数契约不变,只修导致失败的问题。",
        "",
        "## 失败原因",
        lastError,
        "",
        "## 硬性契约(重申)",
        "自包含 ≤200KB;主题 var(--xxx) 带 fallback;动画全部 WAAPI fill:'both';",
        "window.__seek 确定性挂钩(WebGL 场景的一切绘制也在 __seek 内,u_time=t,禁 rAF);",
        "读 window.__PARAMS__;字幕带避让(竖屏 y1418-1562/横屏下缘≤880)",
        "",
        "## 原代码",
        "```html",
        html,
        "```",
        "",
        '输出: {"name":"同前","label":"同前","paramsDoc":"同前","bestFor":"同前","sampleParams":{...},"html":"修复后的完整 HTML"}',
      ].join("\n"),
      { stage: "plan", timeoutMs: 600_000, maxAttempts: 2, fallbackStage: "assets" },
    );
  }
  throw new Error(`镜头模板生成失败(修复 2 轮后仍不可渲染): ${lastError}`);
}

/** 落盘 + 注册:模板 HTML 写 templates-web/,元数据进 registry.json */
async function saveSceneTemplate(
  draft: LlmSceneTemplateResponse,
  html: string,
  orientation: "portrait" | "landscape",
): Promise<SceneRegistryEntry> {
  const name = normalizeSceneName(draft.name ?? "", orientation);
  if (name in WEB_TEMPLATES || loadSceneRegistry().some((e) => e.name === name)) {
    throw new Error(`模板名 ${name} 已存在(内建或已注册),请调整风格描述后重试`);
  }
  const entry: SceneRegistryEntry = {
    name,
    label: typeof draft.label === "string" && draft.label.trim() ? draft.label.trim() : name,
    params: typeof draft.paramsDoc === "string" && draft.paramsDoc.trim() ? draft.paramsDoc.trim() : "title, ...(见模板源码)",
    bestFor: typeof draft.bestFor === "string" && draft.bestFor.trim() ? draft.bestFor.trim() : "自定义场景",
    sample: draft.sampleParams && typeof draft.sampleParams === "object" ? draft.sampleParams : { title: "示例标题" },
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(WORKER_DIR, "templates-web", `${name}.html`), html, "utf-8");
  registerSceneTemplate(entry);
  console.log(`[scene-template-gen] 「${entry.label}」(${name}) 已注册进镜头模板库`);
  return entry;
}
