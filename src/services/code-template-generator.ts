/**
 * LLM 代码渲染模板生成器(2026-08-24)。
 *
 * 与 template-generator.ts(JSON VideoLayer → FFmpeg)平行的第二条生成支路:
 * LLM 直接产出 Revideo TSX 场景代码 → 真实渲染 5s 预览验证可渲染性 →
 * 失败带 stderr 定点修复(≤2 轮)→ 存为 kind=code 模板。
 *
 * 为什么走代码渲染:VideoLayer schema 没有圆角/辉光/弹簧动效字段,
 * 苹果风/赛博风这类设计 ffmpeg 图层表达不出来(keynote-leather 已验证路线可行)。
 */
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { runJsonPrompt } from "./llm-json.js";
import { renderCodeScene } from "./code-scene.js";
import { createTemplate } from "../db/templates-repo.js";
import type { DbTemplate } from "../db/templates-repo.js";
import type { DesignBrief } from "./design-brief.js";

export interface GenerateCodeTemplateInput {
  /** 风格自由描述,如 "赛博朋克霓虹、深色底、青色辉光" */
  style: string;
  /** 画幅:portrait 1080×1920(默认,竖屏短视频)| landscape 1920×1080(横屏) */
  orientation?: "portrait" | "landscape";
  /** 数字人窗口:声明后场景须处理 params.videoSrc(缺省渲染占位) */
  withDigitalHuman?: boolean;
  /** 已确认的设计意图稿(2026-08-25):存在时代码生成从自由创作变为按稿施工 */
  brief?: DesignBrief;
}

interface LlmCodeTemplateResponse {
  name?: string;
  tsx?: string;
}

/** 参数契约:生成代码必须遵守的 params 形状(与 keynote-leather/视频工厂对齐) */
const PARAMS_CONTRACT = `{
  title: string;          // 主标题(渲染时按作品注入)
  kicker?: string;        // 顶部小标
  subtitleCn?: string;    // 中文主字幕
  subtitleEn?: string;    // 英文副字幕
  videoSrc?: string;      // 数字人视频 URL(仅当要求数字人窗口;缺省必须渲染占位形态)
  videoRatio?: number;    // 源片宽高比
  duration?: number;      // 场景总时长(秒)——所有循环动效必须按它算有限轮数
}`;

/** 精简参考样例:展示全部硬性纪律的最小完整场景(供 LLM 模仿结构,而非照抄设计) */
const REFERENCE_EXAMPLE = `
import { makeScene2D, Node, Rect, Txt, Circle } from "@revideo/2d";
import { all, chain, createRef, waitFor } from "@revideo/core";
import { easeOutCubic } from "@revideo/core";
import { spring, SmoothSpring } from "@revideo/core/lib/tweening/spring";
import { FONT } from "../components";

export default function makeScene(params: any) {
  const W = 1920, H = 1080;
  return makeScene2D("custom", function* (view) {
    view.fill("#0e1420");
    const root = createRef<Node>();
    view.add(<Node ref={root} />);
    // 圆角面板 + 辉光:shadowColor/shadowBlur 实现,无需滤镜
    const panel = createRef<Rect>();
    root().add(
      <Rect ref={panel} width={900} height={400} radius={28} y={40}
        fill={"#16202e"} stroke={"#3ec6ff"} lineWidth={2} opacity={0}
        shadowColor={"#3ec6ff"} shadowBlur={60} />,
    );
    root().add(
      <Txt ref={createRef<Txt>()} fontFamily={FONT} text={params.title}
        fontSize={64} fontWeight={700} fill={"#f2f7fb"} y={-H / 2 + 160} />,
    );
    // 弹簧入场(无线性硬切)
    yield* spring(SmoothSpring, 0, 1, 0.01, (v) => {
      panel().opacity(Math.min(1, v * 1.5));
      panel().scale(0.94 + 0.06 * v);
    });
    // 呼吸循环:按 params.duration 算有限轮数,严禁 while(true)
    const total = params.duration ?? 5;
    const cycles = Math.max(1, Math.ceil((total - 2) / 3));
    for (let i = 0; i < cycles; i++) {
      yield* panel().shadowBlur(90, 1.5, easeOutCubic);
      yield* panel().shadowBlur(50, 1.5, easeOutCubic);
    }
  });
}
`;

/** 生成 prompt(导出供单测断言设计约束不丢失) */
export function buildCodeTemplatePrompt(input: GenerateCodeTemplateInput): string {
  const W = input.orientation === "landscape" ? 1920 : 1080;
  const H = input.orientation === "landscape" ? 1080 : 1920;
  return [
    "你是顶级动态视觉设计师 + Revideo 工程师,为短视频设计「代码渲染整片模板」。",
    input.brief
      ? [
          "你必须严格实现以下已确认设计稿(DesignBrief)——palette 逐色落实 hex 与用途、",
          "layout 逐区落实内容与位置、motion 逐条落实入场错峰与循环;",
          "elements 是装饰白名单:只允许出现清单内的装饰,禁止添加稿外元素。",
          `设计稿 JSON:\n${JSON.stringify(input.brief, null, 2)}`,
        ].join("\n")
      : `设计需求:${input.style}`,
    "",
    `## 画布:${W}×${H}(设计空间常量 W/H,居中坐标系,原点在画面中心)`,
    "",
    "## 输出 JSON(代码放在 tsx 字符串字段)",
    '{"name": "模板中文名(≤10字,体现风格)", "tsx": "完整 TSX 源码"}',
    "",
    "## 代码硬性纪律(违反任何一条渲染必挂,将被拒收)",
    "1. export default function(params) 返回 makeScene2D(...);params 契约:",
    `   ${PARAMS_CONTRACT}`,
    '2. 只允许这些 import:@revideo/2d 的 { makeScene2D, Node, Rect, Txt, Line, Circle, Video };' +
      ' @revideo/core 的 { all, chain, createRef, waitFor, easeInOutCubic, easeOutCubic, easeInOutSine };' +
      ' @revideo/core/lib/tweening/spring 的 { spring, SmoothSpring, PlopSpring };' +
      ' ../components 的 { FONT }(文字必须 fontFamily={FONT},否则中文变豆腐块)',
    "3. 严禁 while(true)/任何无限循环——渲染器装载阶段会跑完整个生成器," +
      "无限循环会让渲染永不就绪;所有循环动效按 params.duration 算有限轮数(参考样例)",
    "4. 视频只能用 <Video src={params.videoSrc} />;params.videoSrc 缺省时必须渲染占位形态" +
      "(毛玻璃+播放符之类),禁止写死任何文件路径/URL",
    "5. 禁止使用 fetch/DOM/window/定时器/Math.random(帧必须确定可重现)",
    "",
    "## 设计纪律(苹果式少即是多)",
    "6. 大面积深色留白 + 单一强调色;全模板 ≤3 彩色 + 中性色",
    "6b. 配色与装饰元素必须严格取自设计需求描述(需求说青色霓虹就必须是青色霓虹," +
      "需求说品红就必须出现品红);禁止无视需求默认使用金色/蓝白商务风——需求描述的" +
      "每一种强调色和装饰元素(网格/粒子/光效等)都要在画面里真实出现",
    "7. 圆角面板用 radius;辉光用 shadowColor+shadowBlur(不要叠多层矩形模拟)",
    "8. 入场必须「并行错峰」,严禁逐个 yield* 串行 spring——单个 spring 落定约 1s," +
      "串行 7 个意味着 7 秒后观众才能看到主视觉(实测事故:5s 预览里只有标题," +
      "主视觉/字幕全部来不及出现)。正确模式:入场分组包进 all() + chain(waitFor) 错峰,2s 内全部落定:",
    "```ts",
    "yield* all(",
    "  spring(SmoothSpring, 0, 1, 0.01, (v) => { /* kicker/标题 */ }),",
    "  chain(waitFor(0.12), spring(SmoothSpring, 0, 1, 0.01, (v) => { /* 装饰线/氛围光 */ })),",
    "  chain(waitFor(0.24), spring(PlopSpring, 0, 1, 0.01, (v) => { /* 主视觉面板 */ })),",
    "  chain(waitFor(0.4), spring(SmoothSpring, 0, 1, 0.01, (v) => { /* 中英字幕 */ })),",
    ");",
    "```",
    "   入场落定后再进入呼吸/微动循环",
    "9. 字号阶梯:主标题 56-72px(横屏)/48-64px(竖屏),辅助 ≥24px;字重对比制造层级",
    "10. 布局含:标题区 + 主视觉区" + (input.withDigitalHuman ? "(数字人窗口,圆角+辉光描边+macOS 三灯)" : "(可以是图形/数据/装饰主体)") + " + 底部中英字幕区(subtitleCn/subtitleEn)",
    "",
    "## 参考样例(学它的结构与纪律,设计必须按需求原创,禁止照抄)",
    "```tsx",
    REFERENCE_EXAMPLE,
    "```",
  ].join("\n");
}

/** 渲染前静态检查:快速拦截必然失败的代码(导出供单测) */
export function staticCheckTsx(tsx: string): string[] {
  const errors: string[] = [];
  if (!/export\s+default\s+function/.test(tsx)) errors.push("缺少 export default function 工厂");
  if (!/makeScene2D\(/.test(tsx)) errors.push("缺少 makeScene2D 场景");
  if (/while\s*\(\s*true\s*\)/.test(tsx)) errors.push("存在 while(true) 无限循环(渲染器必挂)");
  if (/from\s+["'](?!@revideo\/2d|@revideo\/core|\.\.\/components)/.test(tsx)) {
    errors.push("存在白名单外的 import(只允许 @revideo/2d、@revideo/core、../components)");
  }
  if (/\bfetch\s*\(|document\.|window\.|setTimeout|setInterval|Math\.random/.test(tsx)) {
    errors.push("存在 fetch/DOM/定时器/Math.random(帧必须确定可重现)");
  }
  return errors;
}

/**
 * 生成一个 code 模板:LLM 产 TSX → 静态检查 → 真实渲染 5s 预览 →
 * 失败带错误信息修复(≤2 轮)→ 入库 kind=code(candidate,含视频预览)。
 */
export async function generateCodeTemplate(input: GenerateCodeTemplateInput): Promise<DbTemplate> {
  if (!input.style?.trim()) throw new Error("style 必填");
  const orientation = input.orientation ?? "portrait";
  const size = orientation === "landscape" ? { w: 1920, h: 1080 } : { w: 1080, h: 1920 };

  const prompt = buildCodeTemplatePrompt({ ...input, orientation });
  let draft = await runJsonPrompt<LlmCodeTemplateResponse>(prompt, {
    stage: "plan", // 代码生成走强力档
    timeoutMs: 600_000,
    maxAttempts: 2,
  });

  // 渲染验证 + 定点修复循环(复用模板生成的 repair 哲学:渲染错误是最高质量的反馈)
  let lastError = "";
  for (let round = 0; round <= 2; round++) {
    const tsx = draft.tsx ?? "";
    const staticErrors = staticCheckTsx(tsx);
    if (staticErrors.length === 0) {
      const preview = await renderCodeScene({
        workId: "tpl_codegen",
        filename: `preview_${randomUUID().slice(0, 8)}`,
        customScene: tsx,
        params: previewParams(input),
        duration: 5,
        size,
      });
      if (preview.success && preview.path) {
        return await saveCodeTemplate(draft, tsx, input, size, preview.path);
      }
      lastError = preview.error ?? "渲染失败(无错误信息)";
    } else {
      lastError = `静态检查未过: ${staticErrors.join("; ")}`;
    }
    if (round === 2) break;
    console.warn(`[code-template-gen] round ${round + 1} 未过,定点修复: ${lastError.slice(0, 200)}`);
    draft = await runJsonPrompt<LlmCodeTemplateResponse>(
      [
        "你是 Revideo 修复师。下面这份 TSX 场景代码渲染失败,请定点修复后输出完整修复版。",
        "保持设计意图不变,只修导致失败的问题。",
        "",
        `## 失败原因`,
        lastError,
        "",
        "## 原代码",
        "```tsx",
        draft.tsx ?? "",
        "```",
        "",
        '输出: {"name": "同前", "tsx": "修复后的完整 TSX 源码"}',
      ].join("\n"),
      { stage: "plan", timeoutMs: 600_000, maxAttempts: 2 },
    );
  }
  throw new Error(`代码模板生成失败(修复 2 轮后仍不可渲染): ${lastError}`);
}

/** 预览渲染参数:让模板在真实参数形态下验证(数字人走占位形态) */
function previewParams(input: GenerateCodeTemplateInput): Record<string, unknown> {
  return {
    title: "预览标题示例",
    kicker: "PREVIEW",
    subtitleCn: "中文字幕预览效果",
    subtitleEn: "English subtitle preview",
  };
}

async function saveCodeTemplate(
  draft: LlmCodeTemplateResponse,
  tsx: string,
  input: GenerateCodeTemplateInput,
  size: { w: number; h: number },
  previewPath: string,
): Promise<DbTemplate> {
  const id = `tpl_code_${randomUUID().slice(0, 8)}`;
  // 预览视频归位到模板预览基建:/api/templates/:id/preview-file 端点按此路径取流
  await mkdir(join(dataDir, "templates"), { recursive: true });
  const previewDest = join(dataDir, "templates", `${id}-preview.mp4`);
  await copyFile(previewPath, previewDest);

  return createTemplate({
    id,
    name: typeof draft.name === "string" && draft.name.trim() ? draft.name.trim() : `代码模板 ${id}`,
    content_form: "video",
    canvas: { width: size.w, height: size.h, fps: 30 },
    variables: [
      { name: "title", type: "text", label: "主标题(默认取作品标题)" },
      { name: "kicker", type: "text", label: "顶部小标(可选)" },
      { name: "subtitleCn", type: "text", label: "中文主字幕(可选)" },
      { name: "subtitleEn", type: "text", label: "英文副字幕(可选)" },
      ...(input.withDigitalHuman
        ? [{ name: "host_video", type: "video" as const, label: "数字人口播视频(可选,缺省占位)" }]
        : []),
    ],
    // kind=code 约定:layers[0] 场景配置;customCode 为 LLM 生成的 TSX 源码
    layers: [{ scene: "custom", customCode: tsx, params: {} }],
    audio: [],
    transitions: [],
    preview_url: `/api/templates/${id}/preview-file`,
    status: "candidate",
    kind: "code",
  });
}
