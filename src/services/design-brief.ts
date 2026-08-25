/**
 * 设计意图稿(DesignBrief)服务(2026-08-25)。
 *
 * 代码模版生成精准化:用户描述 → 结构化意图稿 → 多轮对话微调(不渲染,秒级)
 * → 确认后按稿生成 TSX。意图稿把"一句话→代码"的一步到位失真暴露在
 * 用户看得懂、改得动的中间层。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, loadConfig } from "../config.js";
import { runJsonPrompt } from "./llm-json.js";

export interface DesignBrief {
  styleSummary: string;
  palette: Array<{ hex: string; role: string; note?: string }>;
  layout: Array<{ region: string; content: string; position: string }>;
  /** 装饰元素白名单:代码生成只允许出现这些,不得自行添加 */
  elements: string[];
  motion: { entrance: string; loop: string };
  referenceNotes?: string;
  sourceText: string;
}

export interface BriefInput {
  style: string;
  orientation: "portrait" | "landscape";
  withDigitalHuman?: boolean;
}

export interface BriefSession {
  id: string;
  input: BriefInput;
  brief: DesignBrief;
  history: Array<{ message: string; diffSummary: string }>;
  createdAt: string;
}

const BRIEF_JSON_SHAPE = `{
  "styleSummary": "风格一句话定调",
  "palette": [{"hex": "#rrggbb", "role": "背景|强调|辅助|文字", "note": "用途说明(可选)"}],
  "layout": [{"region": "分区名", "content": "放什么(绑定 title/kicker/subtitleCn/subtitleEn 参数或装饰)", "position": "位置与尺寸描述"}],
  "elements": ["装饰元素1", "装饰元素2"],
  "motion": {"entrance": "入场顺序与错峰秒数", "loop": "循环动效描述"}
}`;

/** brief 生成 prompt(导出供单测断言纪律不丢失) */
export function buildBriefPrompt(input: BriefInput, referenceNotes?: string): string {
  const W = input.orientation === "landscape" ? 1920 : 1080;
  const H = input.orientation === "landscape" ? 1080 : 1920;
  return [
    "你是顶级动态视觉设计总监。把用户的短视频模版风格描述翻译成一份结构化设计意图稿(DesignBrief),供用户确认后交给工程师用代码精确实现。",
    `用户描述:${input.style}`,
    `画幅:${W}×${H}${input.withDigitalHuman ? ";模版需含数字人视频窗口(主视觉区)" : ""}`,
    referenceNotes ? `参考图风格拆解(必须吸收其要点):\n${referenceNotes}` : "",
    "",
    "## 输出 JSON(严格按此形状)",
    BRIEF_JSON_SHAPE,
    "",
    "## 纪律",
    "1. elements 装饰元素必须逐条来自用户描述或参考图拆解,禁止自行添加用户没要的装饰",
    "2. palette ≤3 彩色 + 中性色;每个颜色给具体 hex 和用途;配色必须落实用户点名的颜色(说青色就必须出现青色)",
    "3. layout 自上而下覆盖:顶部小标(kicker)/标题区(title)/主视觉区/底部字幕区(subtitleCn/subtitleEn)",
    "4. motion.entrance 必须给出错峰秒数且 2s 内全部落定;loop 描述呼吸/微动循环",
    "5. 苹果式少即是多:大面积留白 + 单一视觉重心",
  ].join("\n");
}

/** brief 微调 prompt(导出供单测) */
export function buildBriefRevisePrompt(
  current: DesignBrief,
  message: string,
  history: Array<{ message: string; diffSummary: string }>,
): string {
  return [
    "你是设计总监,按用户的修改指令修订设计意图稿(DesignBrief)。",
    `## 当前设计稿\n${JSON.stringify(current, null, 2)}`,
    history.length
      ? `## 历史修改\n${history.map((h) => `- 用户:「${h.message}」→ ${h.diffSummary}`).join("\n")}`
      : "",
    `## 本次修改指令\n${message}`,
    "",
    "## 输出 JSON",
    `{"brief": <修订后的完整 DesignBrief,形状同当前稿>, "diffSummary": "一句话说明改了什么"}`,
    "",
    "## 纪律",
    "1. 只改用户点名的部分,其余字段原样保留",
    "2. elements 白名单语义不变:新增装饰必须来自用户指令",
    "3. palette 仍 ≤3 彩色;motion 入场仍 2s 内全部落定",
  ].join("\n");
}

// ── 会话管理:内存 Map + 落盘 JSON(页面刷新/服务重启不丢) ──
const sessions = new Map<string, BriefSession>();
const SESSIONS_DIR = () => join(dataDir, "brief-sessions");

async function persistSession(s: BriefSession): Promise<void> {
  await mkdir(SESSIONS_DIR(), { recursive: true });
  await writeFile(join(SESSIONS_DIR(), `${s.id}.json`), JSON.stringify(s, null, 2), "utf-8");
}

export function getBriefSession(sessionId: string): BriefSession | undefined {
  return sessions.get(sessionId);
}

/** API 层用:内存 miss 时尝试从磁盘恢复(服务重启后) */
export async function loadBriefSession(sessionId: string): Promise<BriefSession | undefined> {
  const mem = sessions.get(sessionId);
  if (mem) return mem;
  if (!/^brief_[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  const p = join(SESSIONS_DIR(), `${sessionId}.json`);
  if (!existsSync(p)) return undefined;
  try {
    const s = JSON.parse(await readFile(p, "utf-8")) as BriefSession;
    sessions.set(s.id, s);
    return s;
  } catch {
    return undefined;
  }
}

/** 参考图 → 风格拆解要点(视觉模型,kimi 优先 glm 兜底) */
async function analyzeReferenceImage(imagePath: string): Promise<string> {
  const config = await loadConfig();
  const { chatVisionJson } = await import("../llm/vision-json.js");
  const r = await chatVisionJson<{ notes: string }>(config, [imagePath],
    '拆解这张图的设计风格,输出 JSON {"notes": "要点"}:主色(具体 hex 估计)/底色/版式结构/装饰元素/字体气质/动效暗示。只描述你看到的,不要发挥。',
    { timeoutMs: 120_000 });
  return r.notes ?? "";
}

/** 生成 brief v1 并建会话 */
export async function generateBrief(
  input: BriefInput,
  referenceImagePath?: string,
): Promise<{ sessionId: string; brief: DesignBrief }> {
  const referenceNotes = referenceImagePath ? await analyzeReferenceImage(referenceImagePath) : undefined;
  const draft = await runJsonPrompt<Omit<DesignBrief, "sourceText">>(buildBriefPrompt(input, referenceNotes), {
    stage: "plan",
    timeoutMs: 180_000,
    maxAttempts: 2,
  });
  const brief: DesignBrief = { ...draft, ...(referenceNotes ? { referenceNotes } : {}), sourceText: input.style };
  const session: BriefSession = {
    id: `brief_${randomUUID().slice(0, 8)}`,
    input,
    brief,
    history: [],
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  await persistSession(session);
  return { sessionId: session.id, brief };
}

/** 多轮微调:LLM 只改用户点名部分,不渲染,秒级 */
export async function reviseBrief(
  sessionId: string,
  message: string,
): Promise<{ brief: DesignBrief; diffSummary: string }> {
  const session = await loadBriefSession(sessionId);
  if (!session) throw new Error(`brief 会话不存在: ${sessionId}`);
  const r = await runJsonPrompt<{ brief: DesignBrief; diffSummary: string }>(
    buildBriefRevisePrompt(session.brief, message, session.history),
    { stage: "plan", timeoutMs: 180_000, maxAttempts: 2 },
  );
  const brief: DesignBrief = { ...r.brief, sourceText: session.brief.sourceText };
  session.brief = brief;
  session.history.push({ message, diffSummary: r.diffSummary ?? "" });
  await persistSession(session);
  return { brief, diffSummary: r.diffSummary ?? "" };
}
