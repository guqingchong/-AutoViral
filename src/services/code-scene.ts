/**
 * 代码渲染场景素材(2026-08-14 代码渲染素材层集成)。
 *
 * agent 为结构图/流程图/逻辑链条镜头调用,经子项目 worker(Revideo)渲染
 * 程序化动画 mp4。本服务负责:参数校验(审美确定性)、串行队列、
 * spawn 渲染、质量门禁、资产登记。
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { probeMedia } from "../video/ffmpeg.js";

// 子项目路径必须按模块位置解析,不能用 process.cwd()——服务可能从任意目录启动
// (如 autocode start 从用户主目录启动,cwd 下没有 packages/,2026-08-14 live e2e 实测踩中)
const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "code-scene");
const RENDER_TIMEOUT_MS = 300_000;
const VALID_THEMES = new Set(["finance_dark", "warm_gold", "ink_green", "minimal_light", "magazine_light"]);

// 时长上限按模板类型区分(2026-08-24 长口播支持):竖屏镜头模板是 4-8s 素材片段,
// 30s 封顶;keynote-leather 是整片口播,时长跟随数字人源片,600s 封顶
const DURATION_MAX_BY_TEMPLATE: Record<string, number> = { "keynote-leather": 600 };
function durationMaxFor(templateName?: string): number {
  return (templateName && DURATION_MAX_BY_TEMPLATE[templateName]) || 30;
}

// 渲染耗时随时长线性增长:超时按目标时长自适应。2026-09-03 实测修正:
// 含粒子/视频窗/模糊层的复杂模版在 SwiftShader 下约 2.5s/帧(PNG),JPEG 截帧后
// 约 1.5s/帧 → 45s 渲染/1s 成片;旧 15× 预算(0.5s/帧)对复杂模版必然超时
// (ae0 模版渲染 8 连败根因)。预算改为 60× 留足余量,短片兜底放宽到 300s。
function renderTimeoutMs(targetDuration: number): number {
  // 上限 30 分钟:600s keynote 长片按 60× 会到 10h,封顶防僵尸
  return Math.min(1_800_000, Math.max(RENDER_TIMEOUT_MS, Math.ceil(targetDuration * 60_000)));
}

export interface CodeSceneInput {
  workId: string;
  filename: string;
  template?: { name: string; params: Record<string, unknown> };
  customScene?: string;
  /** customScene 形态的参数(2026-08-24 LLM 生成模板参数化):导出厂函数时注入 */
  params?: Record<string, unknown>;
  /** 2026-09-01:LLM 自写 HTML 程序性动画(web 支路 custom 形态)。
   *  自包含单文件 HTML,渲染走 web-worker;源码随产物保留在 assets/clips/code/,
   *  优质场景人工确认后移入 templates-web/ 注册即沉淀为模板 */
  customHtml?: string;
  duration?: number;
  size?: { w: number; h: number };
  theme?: string;
}

// 2026-09-01 视觉升级:9 个竖屏镜头模板已全部迁移至 web 支路(见 WEB_TEMPLATES),
// TEMPLATE_LIMITS 仅保留 Revideo 专属模板;误从本表删除前请先确认 WEB_TEMPLATES 有同名条目。
const TEMPLATE_LIMITS: Record<string, { items?: string; min?: number; max?: number }> = {
  // 2026-08-24:横屏整片数字人口播模板(1920×1080,苹果风×深色皮革),主参数 title(≤18字)
  "keynote-leather": {},
};

/** kind=web HTML 模板注册表(2026-09-01 05 方案 S3):
 *  名字命中此处 → doRender 走 web-worker.mjs(Playwright 截帧),不再查 Revideo 场景表。
 *  schema 语义与 TEMPLATE_LIMITS 相同,校验复用同一套规则。 */
export const WEB_TEMPLATES: Record<string, { items?: string; min?: number; max?: number }> = {
  // 2026-09-01 05 方案:标杆 + 样片批次
  "big-number": {},
  "structure-growth": { items: "branches", min: 2, max: 4 },
  // 2026-09-01 迁移批次(schema 与 Revideo 版 TEMPLATE_LIMITS 一致,agent 调用契约不变)
  "flow-steps": { items: "steps", min: 2, max: 5 },
  "logic-chain": { items: "chain", min: 2, max: 4 },
  "compare-split": {},
  "timeline": { items: "events", min: 2, max: 5 },
  "pyramid": { items: "levels", min: 2, max: 5 },
  "quote-card": {},
  "checklist": { items: "items", min: 2, max: 6 },
  "bar-compare": { items: "bars", min: 2, max: 5 },
  // 2026-09-01 横屏矩阵(-wide 后缀,1920×1080,schema 与竖屏同款一致)
  "big-number-wide": {},
  "structure-growth-wide": { items: "branches", min: 2, max: 4 },
  "flow-steps-wide": { items: "steps", min: 2, max: 5 },
  "logic-chain-wide": { items: "chain", min: 2, max: 4 },
  "compare-split-wide": {},
  "timeline-wide": { items: "events", min: 2, max: 5 },
  "pyramid-wide": { items: "levels", min: 2, max: 5 },
  "quote-card-wide": {},
  "checklist-wide": { items: "items", min: 2, max: 6 },
  "bar-compare-wide": { items: "bars", min: 2, max: 5 },
  // 横屏原生:片头封面(主参数 title,副题 subtitle)
  "cover-title-wide": {},
};

// ── 镜头模板目录(2026-09-02):清单展示 + 预览样片参数的唯一来源 ──
// 此前清单硬编码在 api.ts 的 GET /api/assets/code-scene/templates,预览/注册表
// 无从复用;挪到服务层后 api 清单、模板库页分组、样片预览共用同一份数据。
export interface SceneTemplateMeta {
  name: string;
  label: string;
  /** 参数摘要(字符串描述,供 agent/UI 展示) */
  params: string;
  bestFor: string;
  /** 样片预览参数:必须通过 validateCodeSceneInput(title≤12字,数组在 min-max 内) */
  sample: Record<string, unknown>;
}

const PORTRAIT_CATALOG: SceneTemplateMeta[] = [
  { name: "structure-growth", label: "中心辐射结构图", params: "title, center, branches[2-4]{label,items[]}", bestFor: "中心-分支结构(资金闭环/三段论)",
    sample: { title: "专项债资金闭环", center: "资金闭环", branches: [
      { label: "储备", items: ["项目入库", "前期手续"] },
      { label: "发行", items: ["一案两书", "省级评审"] },
      { label: "管理", items: ["资金拨付", "绩效评价"] },
    ] } },
  { name: "flow-steps", label: "流程步骤推进", params: "title, steps[2-5]{title,desc?}", bestFor: "流程/标准/步骤(退出三标准)",
    sample: { title: "申报发行四步", steps: [
      { title: "项目储备", desc: "筛选入库,完成前期手续" },
      { title: "方案编制", desc: "一案两书,收益测算" },
      { title: "评审发行", desc: "省厅评审,额度分配" },
      { title: "资金管理", desc: "拨付使用,绩效评价" },
    ] } },
  { name: "logic-chain", label: "逻辑链条递进", params: "title, chain[2-4]{text,label?}", bestFor: "因果/递进链条(政策→影响→应对)",
    sample: { title: "政策传导链条", chain: [
      { text: "额度提前下达", label: "政策" },
      { text: "项目开工提速", label: "落地" },
      { text: "有效投资扩大", label: "影响" },
    ] } },
  { name: "big-number", label: "大数字冲击", params: "title, value(数字), format?(plain/percent/wan/yi), unit?, caption?, kicker?, source?", bestFor: "关键数据呈现(债务规模/增速/占比)",
    sample: { title: "债务余额规模", value: 12.8, format: "plain", unit: "万亿", caption: "较上年末增长 8.6%", kicker: "数据透视", source: "财政部" } },
  { name: "compare-split", label: "对比对照", params: "title, left{label,points[2-4]}, right{label,points[2-4]}, verdict?, kicker?, source?", bestFor: "政策前后/方案 PK/新旧对比",
    sample: { title: "新旧机制对比",
      left: { label: "传统机制", points: ["额度年底下达", "项目等资金"] },
      right: { label: "新机制", points: ["额度提前下达", "资金等项目"] },
      verdict: "资金拨付效率显著提升", kicker: "对比解读" } },
  { name: "timeline", label: "时间轴", params: "title, events[2-5]{time,text}, kicker?, source?", bestFor: "政策沿革/事件脉络/发展历程",
    sample: { title: "专项债政策沿革", events: [
      { time: "2015", text: "新预算法实施,专项债登台" },
      { time: "2019", text: "允许作为重大项目资本金" },
      { time: "2024", text: "实行负面清单管理" },
    ] } },
  { name: "pyramid", label: "金字塔层级", params: "title, levels[2-5]{text,desc?}(自下而上,塔底在前), kicker?, source?", bestFor: "体系结构/层级关系/需求层次",
    sample: { title: "项目分层体系", levels: [
      { text: "储备库", desc: "常态化申报" },
      { text: "备选库", desc: "省级初审" },
      { text: "发行库", desc: "两部委审核" },
    ] } },
  { name: "quote-card", label: "金句卡", params: "quote(≤60字), title?, kicker?, source?", bestFor: "金句/原话引用/核心论断",
    sample: { quote: "把每一分钱都花在刀刃上,花在发展的紧要处。", kicker: "核心论断", source: "国务院常务会议" } },
  { name: "checklist", label: "清单打勾", params: "title, items[2-6]{text,done?}, kicker?, source?", bestFor: "要点清单/避坑清单/条件罗列",
    sample: { title: "申报避坑清单", items: [
      { text: "收益覆盖倍数 ≥1.1", done: true },
      { text: "用地手续齐备", done: true },
      { text: "禁止楼堂馆所", done: false },
      { text: "一案两书齐备", done: true },
    ] } },
  { name: "bar-compare", label: "条形数据对比", params: "title, bars[2-5]{label,value}, unit?, source?", bestFor: "轻量数据排行/量级对比(复杂图表仍走 /api/assets/chart)",
    sample: { title: "三省发行规模", bars: [
      { label: "广东", value: 4825 },
      { label: "山东", value: 3910 },
      { label: "浙江", value: 3350 },
    ], unit: "亿", source: "各省财政厅" } },
];

const WIDE_EXTRAS: SceneTemplateMeta[] = [
  { name: "cover-title-wide", label: "封面片头(横屏原生)", params: "title, accent?(渐变高亮词), kicker?, subtitle?, source?", bestFor: "横屏片头/章节页",
    sample: { title: "专项债全景解读", accent: "全景", kicker: "深度专题", subtitle: "从额度分配到项目落地的一条链" } },
  { name: "keynote-leather", label: "横屏数字人口播(苹果风×深色皮革)", params: "title(≤18字), kicker?, subtitleCn?(≤40字), subtitleEn?(≤80字符), videoSrc?, videoRatio?", bestFor: "横屏整片口播",
    sample: { title: "专项债趋势解读", kicker: "KEYNOTE", subtitleCn: "额度前置下的投资新格局", subtitleEn: "Special Bonds Outlook" } },
];

// ── 生成注册表(2026-09-02 镜头模板专属生成渠道) ──
// 设计稿向导生成的 LLM 自写 HTML 模板不入代码常量,落盘 registry.json;
// 清单/校验/渲染判定统一经此处合并,重启后依然可见。
export interface SceneRegistryEntry extends SceneTemplateMeta {
  limits?: { items?: string; min?: number; max?: number };
  createdAt?: string;
}

const REGISTRY_PATH = join(WORKER_DIR, "templates-web", "registry.json");
let registryCache: { mtimeMs: number; entries: SceneRegistryEntry[] } | null = null;

export function loadSceneRegistry(): SceneRegistryEntry[] {
  try {
    const st = statSync(REGISTRY_PATH);
    if (registryCache && registryCache.mtimeMs === st.mtimeMs) return registryCache.entries;
    const raw: unknown = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const entries = (Array.isArray(raw) ? raw : []).filter((e): e is SceneRegistryEntry =>
      !!e && typeof e === "object"
      && typeof (e as SceneRegistryEntry).name === "string" && /^[a-z0-9-]+(-wide)?$/.test((e as SceneRegistryEntry).name)
      && typeof (e as SceneRegistryEntry).label === "string"
      && typeof (e as SceneRegistryEntry).sample === "object" && !!(e as SceneRegistryEntry).sample);
    registryCache = { mtimeMs: st.mtimeMs, entries };
    return entries;
  } catch {
    return [];
  }
}

/** 注册生成模板(同名覆盖);内建模板名拒绝占用 */
export function registerSceneTemplate(entry: SceneRegistryEntry): void {
  if (entry.name in WEB_TEMPLATES || entry.name in TEMPLATE_LIMITS) {
    throw new Error(`模板名 ${entry.name} 与内建模板冲突,请换名`);
  }
  const entries = loadSceneRegistry().filter((e) => e.name !== entry.name);
  entries.push(entry);
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
  registryCache = null;
}

function registryEntry(name: string): SceneRegistryEntry | undefined {
  return loadSceneRegistry().find((e) => e.name === name);
}

/** web 支路判定:内建 WEB_TEMPLATES + 注册表生成模板(渲染一律走 web-worker) */
export function isWebTemplate(name: string): boolean {
  return name in WEB_TEMPLATES || !!registryEntry(name);
}

/** 完整镜头模板清单:竖屏 9 + 横屏衍生 + 横屏原生 + 注册表生成款 */
export function listSceneTemplates(): SceneTemplateMeta[] {
  const wide = PORTRAIT_CATALOG.map((t) => ({ ...t, name: `${t.name}-wide`, label: `${t.label}(横屏)` }));
  return [...PORTRAIT_CATALOG, ...wide, ...WIDE_EXTRAS, ...loadSceneRegistry()];
}

export function findSceneTemplate(name: string): SceneTemplateMeta | undefined {
  return listSceneTemplates().find((t) => t.name === name);
}

/** 纯校验:返回错误列表(空数组=合法) */
export function validateCodeSceneInput(input: CodeSceneInput): string[] {
  const errors: string[] = [];
  if (!input.workId) errors.push("workId 必填");
  if (!input.filename || !/^[\w-]+$/.test(input.filename)) errors.push("filename 必填且仅限字母数字连字符");

  const hasTemplate = !!input.template;
  const hasCustom = !!input.customScene;
  const hasCustomHtml = !!input.customHtml;
  if ([hasTemplate, hasCustom, hasCustomHtml].filter(Boolean).length !== 1) {
    errors.push("template / customScene / customHtml 必须三选一");
  } else if (hasCustomHtml) {
    const html = input.customHtml!;
    if (html.length > 200_000) errors.push(`customHtml ≤200KB(当前 ${Math.round(html.length / 1024)}KB)`);
    if (!/<\s*(html|!doctype|div|body)/i.test(html)) errors.push("customHtml 须为 HTML 文档片段");
    // 静态黑名单(终审 C1 纵深防御;真正的隔离在 web-worker 的 page.route 网络锁)
    const banned = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /<script[^>]*\bsrc\s*=/i, /https?:\/\//i, /\bwindow\.open\s*\(/, /\blocation\s*(?:\.href\s*)?=/];
    const hit = banned.find((re) => re.test(html));
    if (hit) errors.push(`customHtml 含禁止的外联/网络调用模式(${hit.source})——模板必须完全自包含`);
  } else if (hasTemplate) {
    const t = input.template!;
    const limit = WEB_TEMPLATES[t.name] ?? TEMPLATE_LIMITS[t.name] ?? registryEntry(t.name)?.limits ?? (registryEntry(t.name) ? {} : undefined);
    if (!limit) {
      errors.push(`未知场景模板: ${t.name}(可选: ${[...Object.keys(WEB_TEMPLATES), ...Object.keys(TEMPLATE_LIMITS), ...loadSceneRegistry().map((e) => e.name)].join("/")})`);
    } else {
      const p = t.params ?? {};
      // -wide 横屏变体与竖屏同款同 schema:参数校验一律按基名判定(2026-09-02,
      // 此前 quote-card-wide/structure-growth-wide 漏校验 quote/center)
      const baseName = t.name.endsWith("-wide") ? t.name.slice(0, -5) : t.name;
      // quote-card 以 quote 为主参数,其余模板以 title 为主参数
      if (baseName === "quote-card") {
        if (typeof p.quote !== "string" || !p.quote.trim()) errors.push("params.quote 必填");
        else if ([...p.quote].length > 60) errors.push(`params.quote ≤60 字(当前 ${[...p.quote].length})`);
      } else {
        const title = p.title;
        if (typeof title !== "string" || !title.trim()) errors.push("params.title 必填");
        else {
          // keynote-leather 横屏标题区更宽,上限放宽到 18 字;竖屏镜头模板仍 12 字
          const titleMax = t.name === "keynote-leather" ? 18 : 12;
          if ([...title].length > titleMax) errors.push(`params.title ≤${titleMax} 字(当前 ${[...title].length})`);
        }
      }
      if (t.name === "keynote-leather") {
        for (const key of ["kicker", "subtitleCn", "subtitleEn", "videoSrc"] as const) {
          if (p[key] !== undefined && typeof p[key] !== "string") errors.push(`params.${key} 须为字符串`);
        }
        if (typeof p.subtitleCn === "string" && [...p.subtitleCn].length > 40) {
          errors.push(`params.subtitleCn ≤40 字(当前 ${[...p.subtitleCn].length})`);
        }
        if (typeof p.subtitleEn === "string" && p.subtitleEn.length > 80) {
          errors.push(`params.subtitleEn ≤80 字符(当前 ${p.subtitleEn.length})`);
        }
        if (p.videoRatio !== undefined && (typeof p.videoRatio !== "number" || p.videoRatio <= 0)) {
          errors.push("params.videoRatio 须为正数(源片宽高比)");
        }
      }
      if (baseName === "structure-growth" && (typeof p.center !== "string" || !p.center.trim())) {
        errors.push("params.center 必填");
      }
      if (baseName === "big-number" && typeof p.value !== "number") {
        errors.push("params.value 必填且为数字");
      }
      if (baseName === "compare-split") {
        for (const side of ["left", "right"] as const) {
          const s = p[side] as { label?: string; points?: unknown[] } | undefined;
          if (!s || typeof s.label !== "string" || !Array.isArray(s.points) || s.points.length < 1 || s.points.length > 4) {
            errors.push(`params.${side}.{label,points[1-4]} 必填`);
          }
        }
      }
      if (limit.items) {
        const items = p[limit.items];
        if (!Array.isArray(items)) errors.push(`params.${limit.items} 必须是数组`);
        else if (items.length < limit.min! || items.length > limit.max!) {
          errors.push(`params.${limit.items} 数量须 ${limit.min}-${limit.max}(当前 ${items.length})`);
        }
      }
    }
  }

  if (input.duration !== undefined) {
    const durMax = durationMaxFor(input.template?.name);
    if (input.duration < 1 || input.duration > durMax) {
      errors.push(`duration 须在 1-${durMax} 秒之间`);
    }
  }
  if (input.theme !== undefined && !VALID_THEMES.has(input.theme)) {
    errors.push(`theme 非法: ${input.theme}(可选: ${[...VALID_THEMES].join("/")})`);
  }
  if (input.size && ((input.size.w ?? 0) < 256 || (input.size.h ?? 0) < 256)) {
    errors.push("size 宽高均须 ≥256");
  }
  return errors;
}

// ── 以下为渲染执行(追加到 Task 6 的文件末尾) ──

export interface CodeSceneResult {
  success: boolean;
  path?: string;
  url?: string;
  duration?: number;
  error?: string;
  code?: "TIMEOUT" | "RENDER_FAILED" | "INVALID_PARAMS" | "TEMPLATE_TOO_HEAVY";
}

// 渲染并发池(批次11.6,2026-08-31 实测:dde assets 阶段 3.4h,20+ 模板镜头串行渲染是主因):
// 每个任务本就是独立 worker 进程 + 独立 project 文件,模板场景之间无共享状态,允许并行;
// customScene 会写共享的 src/custom/current.tsx(批次8 已证互踩),仍独占整个池。
// 路数:2026-09-07 实测修正 3→2——SwiftShader 软渲染吃满 CPU 核,3 路并行 + agent/评审/ffmpeg
// 并发时单帧 0.3s→2.5s+,一批 5 个渲染 4 个集体超时(360s)(w_20260907_1952_ef9 实证),
// 并行省下的时间被超时重试全赔回去。可用 AUTOVIRAL_CODE_SCENE_PARALLEL 覆盖。
const MAX_PARALLEL = Math.max(1, Number(process.env.AUTOVIRAL_CODE_SCENE_PARALLEL ?? 2) || 2);
let running = 0;
let customRunning = false;
const waitQueue: Array<{ custom: boolean; grant: () => void }> = [];

function pumpQueue(): void {
  if (customRunning) return;
  while (running < MAX_PARALLEL && waitQueue.length) {
    const next = waitQueue[0];
    if (next.custom && running > 0) break; // custom 需要独占,等模板任务排空
    waitQueue.shift();
    running++;
    if (next.custom) customRunning = true;
    next.grant();
  }
}

function acquireRenderSlot(custom: boolean): Promise<void> {
  return new Promise((resolve) => { waitQueue.push({ custom, grant: resolve }); pumpQueue(); });
}

function releaseRenderSlot(custom: boolean): void {
  running--;
  if (custom) customRunning = false;
  pumpQueue();
}

/**
 * R4 模板复杂度预检（静态快筛）：对 customHtml 与注册 web 模板支路生效。
 * 阈值来自施工图 R4（初值，需灰度调参）：绘制对象 ≥200 / 每帧 shadowBlur ≥60 /
 * 无限循环动画 ≥4 → 判"模板过重"。
 * 2026-09-07 X13 验收修复:
 *  - 粒子计数补两种写法:`var techCount = 120` 变量定义(ae0 事故模板正是这种,
 *    旧正则 `for(i<N)` 漏判)与 `new Array(120)`/`Array.from({length:120})`;
 *  - shadowBlur 判定补"组合规则":有 shadowBlur 且对象数 ≥60 即过重
 *    (ae0 杀手组合:120 粒子 × 每帧高斯阴影 ≈ 2.5s/帧,单看次数/粒子数都会漏);
 *  - WebGL 从硬拒绝改预警(软渲染极慢,但是否超时由 benchmarkFrame 实测终判)。
 * 导出供 M5 模板回归（templates-repo.triggerTemplateRegression）复用。
 */
export function precheckTemplate(html: string): string | null {
  if (!html) return null;
  const loopCounts = [...html.matchAll(/for\s*\([^)]*\w+\s*<\s*(\d+)/g)].map((m) => Number(m[1]));
  const varCounts = [...html.matchAll(/(?:const|let|var)\s+\w*(?:count|total|num)\w*\s*=\s*(\d+)/gi)].map((m) => Number(m[1]));
  const arrCounts = [...html.matchAll(/new\s+Array\s*\(\s*(\d+)\s*\)|Array\.from\s*\(\s*\{\s*length\s*:\s*(\d+)/g)]
    .map((m) => Number(m[1] ?? m[2]));
  const particles = [...loopCounts, ...varCounts, ...arrCounts]
    .reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
  const shadowBlurAssigns = (html.match(/shadowBlur\s*=\s*\d+/g) ?? []).length;
  const hasShadowBlur = /shadowBlur\s*=\s*[1-9]/.test(html);
  const infinite = (html.match(/iterations\s*:\s*Infinity|requestAnimationFrame|setInterval/g) ?? []).length;
  const webgl = /getContext\s*\(\s*['"]webgl|three\.js|THREE\./i.test(html);
  if (webgl) {
    console.warn("[code-scene] 模板含 WebGL/three.js——SwiftShader 软渲染下极慢,建议减重(由 benchmarkFrame 实测终判)");
  }
  const shadowBlurCombo = hasShadowBlur && particles >= 60;
  if (particles >= 200 || shadowBlurAssigns >= 60 || infinite >= 4 || shadowBlurCombo) {
    return `模板过重（particles≈${particles}, shadowBlur=${shadowBlurAssigns}${shadowBlurCombo ? "(×多对象组合)" : ""}, 无限动画=${infinite}），请减重或降级`;
  }
  return null;
}

/** benchmarkFrame 预算倍率:预估总渲染时长 > renderTimeoutMs × 该值即拒绝(留 20% 安全边际) */
const BENCHMARK_BUDGET_RATIO = 0.8;

/**
 * R4 benchmarkFrame 动态终判(2026-09-07 业主拍板补做):静态阈值只作快筛,最终判定
 * 靠测量——Playwright 离屏渲 1 帧实测 wall-clock,× duration × fps 预估总时长,超预算
 * 80% 即拒绝。只对含动画标记的 HTML 执行(静态卡无 rAF/Infinity,省一次浏览器启动)。
 * 探测自身失败不阻断(保守放行,由超时预算兜底)。
 */
export async function benchmarkFrame(html: string, durationSec: number, fps = 30): Promise<string | null> {
  if (!/requestAnimationFrame|setInterval|iterations\s*:\s*Infinity/i.test(html)) return null;
  try {
    const { chromium } = await import("playwright");
    // 默认 chromium 未安装时回退系统 Edge(channel 模式,与 web-worker 一致)
    const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "msedge" }));
    try {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      const t0 = Date.now();
      await page.screenshot({ type: "jpeg", quality: 50 });
      const perFrameMs = Date.now() - t0;
      const estimatedMs = perFrameMs * durationSec * fps;
      const budgetMs = renderTimeoutMs(durationSec);
      if (estimatedMs > budgetMs * BENCHMARK_BUDGET_RATIO) {
        return `模板过重(实测 ${perFrameMs}ms/帧,预估 ${(estimatedMs / 1000).toFixed(0)}s > 预算 ${(budgetMs / 1000).toFixed(0)}s 的 80%),请减重或降级`;
      }
      return null;
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn("[code-scene] benchmarkFrame 探测失败(保守放行,由超时预算兜底):", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function renderCodeScene(input: CodeSceneInput): Promise<CodeSceneResult> {
  const errors = validateCodeSceneInput(input);
  if (errors.length) return { success: false, error: errors.join("; "), code: "INVALID_PARAMS" };
  // R4 预检：重模板直接拒绝，不进渲染队列（修 120 粒子 8 连败超时）
  if (input.customHtml) {
    const precheckErr = precheckTemplate(input.customHtml);
    if (precheckErr) return { success: false, error: precheckErr, code: "TEMPLATE_TOO_HEAVY" };
    // X13:benchmarkFrame 动态终判(静态快筛之后,靠 1 帧实测而非猜阈值)
    const benchErr = await benchmarkFrame(input.customHtml, input.duration ?? 6);
    if (benchErr) return { success: false, error: benchErr, code: "TEMPLATE_TOO_HEAVY" };
  }
  // X13 验收修复:注册 web 模板同样过静态预检(此前只查 customHtml——
  // 注册模板照样可能含重特效,ae0 事故模板 tpl_code_f752958d 即为注册模板类来源)
  if (input.template?.name && WEB_TEMPLATES[input.template.name]) {
    try {
      const tplHtml = readFileSync(join(WORKER_DIR, "templates-web", `${input.template.name}.html`), "utf-8");
      const precheckErr = precheckTemplate(tplHtml);
      if (precheckErr) return { success: false, error: `模板 ${input.template.name}: ${precheckErr}`, code: "TEMPLATE_TOO_HEAVY" };
    } catch { /* 模板文件不可读不阻断,由渲染阶段自身报错 */ }
  }
  if (!existsSync(join(WORKER_DIR, "node_modules"))) {
    return { success: false, error: "code-scene 子项目未安装依赖,请先执行: cd packages/code-scene && npm install", code: "RENDER_FAILED" };
  }
  const isCustom = !!input.customScene;
  await acquireRenderSlot(isCustom);
  try {
    return await doRender(input);
  } finally {
    releaseRenderSlot(isCustom);
  }
}

async function doRender(input: CodeSceneInput): Promise<CodeSceneResult> {
  let stagedCleanup: (() => Promise<void>) | undefined;
  try {
  const jobId = `cs_${randomUUID().slice(0, 8)}`;
  const outDirAbs = join(dataDir, "works", input.workId, "assets", "clips", "code");
  await mkdir(outDirAbs, { recursive: true });
  const outFile = `${input.filename}.mp4`;

  const isKeynote = input.template?.name === "keynote-leather";
  // 横屏镜头模板(2026-09-01 横屏矩阵):-wide 后缀,默认 1920×1080
  const isWide = !!input.template?.name?.endsWith("-wide");
  const isCustom = !!input.customScene;
  // LLM 自写 HTML(web 支路 custom 形态):自包含文件,无共享状态,不占 custom 独占池
  const isCustomHtml = !!input.customHtml;
  // web 判定上移(2026-09-01 修复):duration 注入点需要它;spec 增补段复用同一变量
  // 2026-09-02:注册表生成模板(registry.json)同样走 web 支路
  const isWeb = !!input.template && isWebTemplate(input.template.name);
  const targetDuration = Math.min(Math.max(input.duration ?? (isKeynote ? 8 : 6), 1), durationMaxFor(input.template?.name ?? (isCustom || isCustomHtml ? "keynote-leather" : undefined)));
  const params: Record<string, unknown> | undefined = input.template
    ? { ...input.template.params, theme: input.theme ?? input.template.params.theme }
    : input.params ? { ...input.params } : undefined;
  if ((isKeynote || isCustom || isWeb || isCustomHtml) && params) {
    // 场景动画/呼吸循环轮数按 params.duration 自适应,必须与渲染目标时长一致
    // (web 支路:__PARAMS__.duration 驱动模板短/长镜头分支,缺失则永远走默认长分支)
    params.duration = targetDuration;
  }
  if ((isKeynote || isCustom) && params) {
    // 数字人源片中转(2026-08-24):revideo 渲染器只认 vite public 下的 URL 形式
    // src("/xxx.mp4"),本地绝对路径会被当相对 URL → MEDIA_ERR_SRC_NOT_SUPPORTED 挂死。
    // 渲染前复制进 public/staged/,渲染结束(成败)即清理。仅 keynote/custom,web 支路不涉及。
    const videoSrc = params.videoSrc;
    if (typeof videoSrc === "string" && videoSrc && !videoSrc.startsWith("/") && !/^https?:\/\//.test(videoSrc)) {
      const staged = await stageDigitalHumanAsset(jobId, videoSrc);
      if (!staged) {
        return { success: false, error: `数字人源片不存在或不可读: ${videoSrc}`, code: "INVALID_PARAMS" };
      }
      params.videoSrc = staged.url;
      stagedCleanup = staged.cleanup;
      // 源片宽高比自动探测(默认 720/1280 竖屏,非竖屏源片须给真实比例,否则 cover 构图错位)
      if (params.videoRatio === undefined && staged.ratio) params.videoRatio = staged.ratio;
    }
  }

  const spec = {
    jobId,
    scene: input.template ? input.template.name : isCustomHtml ? "custom-html" : "custom",
    params,
    customCode: input.customScene,
    duration: targetDuration,
    // keynote-leather 是横屏整片模板,默认 1920×1080;其余模板默认竖屏 1080×1920
    // keynote-leather 与 -wide 横屏模板默认 1920×1080;其余模板默认竖屏 1080×1920
    width: input.size?.w ?? ((isKeynote || isWide) ? 1920 : 1080),
    height: input.size?.h ?? ((isKeynote || isWide) ? 1080 : 1920),
    outFile,
    outDir: outDirAbs,
  };
  const specPath = join(outDirAbs, `${jobId}.spec.json`);
  await writeFile(specPath, JSON.stringify(spec), "utf-8");

  const outputPath = join(outDirAbs, outFile);
  // web 支路(2026-09-01 05 方案 S3):模板名命中 WEB_TEMPLATES → 一律走 web-worker.mjs
  // (Playwright 截帧),不再查 Revideo 场景注册表;spec 增补 templatePath/theme/ffmpegPath
  if (isWeb) {
    const { getFFmpegPath } = await import("../video/ffmpeg.js");
    Object.assign(spec, {
      templatePath: join(WORKER_DIR, "templates-web", `${input.template!.name}.html`),
      theme: input.theme ?? (input.template!.params.theme as string | undefined) ?? "finance_dark",
      ffmpegPath: await getFFmpegPath(),
    });
    await writeFile(specPath, JSON.stringify(spec), "utf-8"); // 重写增补后的 spec
  }
  if (isCustomHtml) {
    // customHtml:源码落盘在产物旁(<filename>.custom.html),一供渲染二供沉淀——
    // 优质自定义场景人工确认后移入 templates-web/ 注册即成为正式模板
    const { getFFmpegPath } = await import("../video/ffmpeg.js");
    const htmlPath = join(outDirAbs, `${input.filename}.custom.html`);
    await writeFile(htmlPath, input.customHtml!, "utf-8");
    Object.assign(spec, {
      templatePath: htmlPath,
      theme: input.theme ?? (params?.theme as string | undefined) ?? "finance_dark",
      ffmpegPath: await getFFmpegPath(),
    });
    await writeFile(specPath, JSON.stringify(spec), "utf-8");
  }
  const useWebWorker = isWeb || isCustomHtml;
  try {
    // 渲染前清掉同名旧产物:渲染器对已有 outFile 可能跳过重渲染(实测 18:24 旧 3.8s
    // 产物原地复用),残留旧文件会污染补时判定与"成功但产物陈旧"的假象
    await rm(outputPath, { force: true });
    await runWorkerWithRetry(specPath, renderTimeoutMs(targetDuration), useWebWorker ? "web-worker.mjs" : "worker.mjs");
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), code: err instanceof WorkerTimeout ? "TIMEOUT" : "RENDER_FAILED" };
  } finally {
    // spec 是一次性输入,渲染结束即清理,避免污染用户可见的 assets 目录(工程债 C2,2026-08-17)
    rm(specPath, { force: true }).catch(() => {});
    // X13 验收修复(2026-09-07,R4):超时/失败后清理僵尸帧目录——web-worker 只在编码
    // 成功时 rm framesDir,taskkill 后 ${jobId}_frames 残留(ae0 的 cs_*_frames 滞留根因)
    rm(join(outDirAbs, `${jobId}_frames`), { recursive: true, force: true }).catch(() => {});
  }
  if (!existsSync(outputPath)) {
    return { success: false, error: "worker 完成但未产出文件", code: "RENDER_FAILED" };
  }

  let info = await probeMedia(outputPath);
  // duration 参数生效化(2026-08-19 根因修复):场景自然时长与 spec.duration 无关,
  // 不足目标时长时 tpad 克隆末帧补齐(详见 decidePadSeconds 注释)
  const pad = decidePadSeconds(info.duration, targetDuration);
  // web 支路(含 customHtml)产物时长恒等于 targetDuration(截帧帧数即目标),跳过补时
  if (!useWebWorker && pad > 0) {
    await padWithLastFrame(outputPath, pad);
    info = await probeMedia(outputPath);
  }
  // 质量门禁:无声中间段语义(2026-08-14 起 expectAudio 区分)
  try {
    const { runQualityGate } = await import("./quality-gate.js");
    const report = await runQualityGate(outputPath, { expectAudio: false });
    await writeFile(join(outDirAbs, `${input.filename}.quality.json`), JSON.stringify(report, null, 2), "utf-8");
  } catch { /* 门禁失败不阻断 */ }

  // C5 素材沉淀:登记资产库
  try {
    const { createAsset } = await import("../db/assets-repo.js");
    createAsset({
      name: `代码场景 ${input.template?.name ?? "custom"}: ${String(input.template?.params?.title ?? input.filename)}`,
      file_path: outputPath,
      category: "general",
      type: "video",
      tags: [input.template?.name, "程序化动画", "code-scene"].filter((t): t is string => !!t),
      source: "self-generated",
      license: "unknown",
      compliance_status: "passed",
      metadata: { workId: input.workId, assetKind: "code-scene", template: input.template?.name },
      usage_count: 0,
    });
  } catch { /* 登记失败不阻断 */ }

  const rel = `clips/code/${outFile}`;
  return { success: true, path: outputPath, url: `/api/works/${input.workId}/assets/${rel}`, duration: info.duration };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), code: "RENDER_FAILED" };
  } finally {
    if (stagedCleanup) await stagedCleanup();
  }
}

/**
 * 数字人源片中转:把本地文件复制进 code-scene 的 vite public/staged/,
 * 返回渲染可用的 URL 与源片宽高比;cleanup 在渲染结束后删除中转文件。
 * 源片不存在时返回 null(调用方按参数错误处理)。
 */
async function stageDigitalHumanAsset(
  jobId: string,
  videoSrc: string,
): Promise<{ url: string; ratio?: number; cleanup: () => Promise<void> } | null> {
  if (!existsSync(videoSrc)) return null;
  const ext = (videoSrc.match(/\.\w+$/)?.[0] ?? ".mp4").toLowerCase();
  const stagedName = `${jobId}${ext}`;
  const stagedDir = join(WORKER_DIR, "public", "staged");
  const stagedPath = join(stagedDir, stagedName);
  await mkdir(stagedDir, { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  await copyFile(videoSrc, stagedPath);
  let ratio: number | undefined;
  try {
    const info = await probeMedia(stagedPath);
    if (info.width && info.height) ratio = info.width / info.height;
  } catch { /* 探测失败用模板默认比例 */ }
  return {
    url: `/staged/${stagedName}`,
    ratio,
    cleanup: async () => { await rm(stagedPath, { force: true }).catch(() => {}); },
  };
}

class WorkerTimeout extends Error { constructor(ms: number) { super(`渲染超时(${Math.round(ms / 1000)}s)`); } }

/**
 * 末帧定格补时判定(2026-08-19 根因修复):Revideo 场景是生成器,内部动画时间轴
 * 硬编码,自然时长由模板内容决定(flow-steps 3 步=3.8s,quote-card≈2.07s),
 * 与 spec.duration 无关(project range 只是渲染窗口上限,不会拉长场景)——
 * agent 曾报告"duration 参数似乎不生效(总是 2.07s)"。
 * 修复策略:不足目标时长时用 tpad 克隆末帧补齐(入场动画保持干脆,尾部定格正是
 * 旁白讲解所需的停留);超出目标不裁短(裁切会破坏动画完整性);容差 0.1s
 * (曾用 0.25,3.8s 自然时长 vs 4s 目标的 0.2s 差被吞掉,duration 依旧"不生效")。
 */
export function decidePadSeconds(actual: number | undefined, target: number, tolerance = 0.1): number {
  if (!actual || actual <= 0) return 0;
  const gap = target - actual;
  return gap > tolerance ? gap : 0;
}

/** 用 tpad 克隆末帧把无声渲染段延长 pad 秒(原地替换,返回新探测信息) */
export async function padWithLastFrame(outputPath: string, padSeconds: number): Promise<void> {
  const { getFFmpegPath } = await import("../video/ffmpeg.js");
  const ffmpeg = await getFFmpegPath();
  const tmp = outputPath.replace(/\.mp4$/, ".pad.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(ffmpeg, [
    "-i", outputPath,
    "-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-an", "-y", tmp,
  ]);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, outputPath);
}

/**
 * 导航超时自动重试一次(2026-08-24 端口竞态根治的兜底):
 * worker 每任务已随机 vite 端口,但 Edge/系统资源未释放仍可能偶发
 * "Navigation timeout"——这是瞬时故障,重试(新进程+新端口)即可恢复;
 * 其他错误(参数/代码问题)重试无意义,直接抛出。
 */
async function runWorkerWithRetry(specPath: string, timeoutMs: number, workerFile = "worker.mjs"): Promise<void> {
  try {
    await runWorker(specPath, timeoutMs, workerFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof WorkerTimeout || !/navigation timeout/i.test(msg)) throw err;
    console.warn("[code-scene] navigation timeout,重试一次(新端口)");
    await runWorker(specPath, timeoutMs, workerFile);
  }
}

function runWorker(specPath: string, timeoutMs: number, workerFile = "worker.mjs"): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [workerFile, specPath], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      // R4 进程组 kill：Windows 用 taskkill /T 连带杀死 Playwright/Edge 子进程（修 #02 孤儿进程）
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        proc.kill("SIGKILL");
      }
      reject(new WorkerTimeout(timeoutMs));
    }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`渲染失败(exit ${code}): ${stderr.slice(-600)}`));
    });
  });
}
