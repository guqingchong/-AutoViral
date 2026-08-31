/**
 * Content generator (PRD §4.1.4).
 *
 * Multi-step generation: outline -> draft -> refine, with toneProfile and
 * evolution rules injected. Produces 1500–3000 字 articles and 分镜口播脚本.
 */

import { runJsonPrompt } from "./llm-json.js";
import { buildTonePrompt } from "./tone-profile.js";
import { buildPromptInjection, injectEvolution } from "./evolution-applier.js";
import type { DbTopic } from "../db/types.js";

export interface GeneratedArticle {
  title: string;
  content: string;
  platform: string;
}

export interface GeneratedScript {
  scenes: Array<{ timestamp: string; narration: string; visual: string }>;
  duration: number;
}

export interface ContentGenOptions {
  toneProfile?: Record<string, unknown> | null;
  /** @deprecated 假开关(2026-08-28 批次5.5 删除):直连架构下 runJsonPrompt 恒走 llm.models.script 档 */
  model?: string;
}

function buildContext(topic: DbTopic, platform: string): string {
  const plan = topic.content_plan as Record<string, unknown> | undefined;
  return [
    `选题：${topic.title}`,
    `描述：${topic.description ?? ""}`,
    `情绪类型：${topic.emotion_type ?? ""} / ${topic.emotion_subtype ?? ""}`,
    `标签：${topic.tags.join(", ")}`,
    `切入角度：${topic.content_angles.join("；")}`,
    `爆款开头：${topic.example_hook ?? ""}`,
    plan ? `内容谋划：${JSON.stringify(plan)}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Step 1: Generate a structured outline from the topic.
 */
async function generateOutline(topic: DbTopic, platform: string, opts?: ContentGenOptions): Promise<Record<string, unknown>> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const evolution = buildPromptInjection("prompt");
  const prompt = injectEvolution(
    [
      tonePrefix,
      evolution.prefix ?? "",
      `为 ${platform} 平台，基于以下选题生成一篇深度文章的结构化大纲。`,
      buildContext(topic, platform),
      `目标长度 1500–3000 字。`,
      `大纲需包含：标题、核心论点、3-5 个主要章节（每章含要点）、开头钩子、结尾 CTA。`,
      `**事实密度要求**：每个章节必须包含至少 1 个具名事实锚点——具体数字/日期/政策文件名/公司或人物名/信源（如"150号文""标普信评""115家"），禁止只有空泛概念的章节。`,
      `输出 JSON：{"title":"标题","hook":"开头钩子","sections":[{"heading":"章节标题","points":["要点1","要点2"],"facts":["事实锚点1"]}],"cta":"结尾CTA"}`,
    ].join("\n"),
    evolution
  );
  return runJsonPrompt<Record<string, unknown>>(prompt, { timeoutMs: 120_000 });
}

/**
 * Step 2: Expand the outline into a full draft article.
 */
async function expandOutline(
  topic: DbTopic,
  platform: string,
  outline: Record<string, unknown>,
  opts?: ContentGenOptions
): Promise<GeneratedArticle> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const prompt = [
    tonePrefix,
    `基于以下大纲，撰写完整的中文文章/文案。要求：`,
    `- 口语化、有信息密度、自然不生硬`,
    `- 每个章节展开 300-600 字`,
    `- 保持大纲的结构和论点`,
    `- **事实密度硬指标**：正文中必须保留并展开大纲里的事实锚点；每分钟阅读量（约 300 字）至少包含 2 个具名事实（数字/日期/政策名/主体名/信源）。禁止"近年来""相关部门""业内人士"这类无出处模糊表述`,
    `- **禁止无出处断言**：涉及政策、数据、事件的陈述必须指明来源（如"财新报道""标普信评显示""150号文明确"），没有来源支撑的断言宁可不写`,
    `大纲：${JSON.stringify(outline)}`,
    buildContext(topic, platform),
    `输出 JSON：{"title":"标题","content":"完整正文（含换行，1500-3000字）"}`,
  ].join("\n");
  return runJsonPrompt<GeneratedArticle>(prompt, { timeoutMs: 180_000 });
}

/**
 * Step 3: Refine the draft for quality (flow, hook strength, CTA).
 */
async function refineArticle(article: GeneratedArticle, opts?: ContentGenOptions): Promise<GeneratedArticle> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const prompt = [
    tonePrefix,
    `请精修以下文章，提升质量：`,
    `1. 强化开头钩子的吸引力`,
    `2. 优化段落过渡，让行文更流畅`,
    `3. 确保结尾 CTA 有力、明确`,
    `4. 修正任何生硬或重复的表达`,
    `5. 保持原有信息、数据和事实锚点不变（不得删改具体数字/日期/信源）`,
    `原标题：${article.title}`,
    `原文：${article.content}`,
    `输出 JSON：{"title":"精修后标题","content":"精修后正文"}`,
  ].join("\n");
  return runJsonPrompt<GeneratedArticle>(prompt, { timeoutMs: 180_000 });
}

export async function generateArticleFromTopic(topic: DbTopic, platform: string, opts?: ContentGenOptions): Promise<GeneratedArticle> {
  const outline = await generateOutline(topic, platform, opts);
  const draft = await expandOutline(topic, platform, outline, opts);
  try {
    return await refineArticle(draft, opts);
  } catch {
    return draft;
  }
}

export async function generateScriptFromArticle(article: GeneratedArticle, duration = 180, opts?: ContentGenOptions): Promise<GeneratedScript> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const evolution = buildPromptInjection("prompt");
  const prompt = injectEvolution(
    [
      tonePrefix,
      evolution.prefix ?? "",
      `将以下文章改写成 ${Math.floor(duration / 60)} 分钟口播视频脚本。`,
      `要求：`,
      `- 开头 3 秒内必须有强钩子`,
      `- 每个场景对应一段口播文案 + 画面描述`,
      `- 口播自然、适合数字人朗读`,
      // 批次11.5(2026-08-31 实测):旁白被写成逗号碎片("6600万元,买一个数字孪生雄安。
      // 先克隆一座城,再动一块砖。"),TTS 读出来全程断气。旁白是完整口语句,字幕断行
      // 由字幕工具完成,与文案无关。
      `- 旁白必须是完整口语句(主谓宾齐全):禁止逗号碎片堆叠(每隔几个字一个逗号);断句节奏靠句号,字幕断行由字幕工具自动完成,写旁白时不考虑行宽`,
      `- 结尾有明确 CTA`,
      `- **事实密度硬指标**：保留文章中的全部具名事实（数字/日期/政策名/主体/信源），每分钟口播至少 2 个；禁止把具体事实泛化成"很多地方""相关规定"`,
      `标题：${article.title}`,
      `文章：${article.content}`,
      `输出 JSON：{"scenes":[{"timestamp":"0:00-0:15","narration":"口播文案","visual":"画面描述"}],"duration":${duration}}`,
    ].join("\n"),
    evolution
  );
  return runJsonPrompt<GeneratedScript>(prompt, { timeoutMs: 180_000 });
}