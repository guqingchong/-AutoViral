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
      `输出 JSON：{"title":"标题","hook":"开头钩子","sections":[{"heading":"章节标题","points":["要点1","要点2"]}],"cta":"结尾CTA"}`,
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
    `5. 保持原有信息和结构不变`,
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
      `- 结尾有明确 CTA`,
      `标题：${article.title}`,
      `文章：${article.content}`,
      `输出 JSON：{"scenes":[{"timestamp":"0:00-0:15","narration":"口播文案","visual":"画面描述"}],"duration":${duration}}`,
    ].join("\n"),
    evolution
  );
  return runJsonPrompt<GeneratedScript>(prompt, { timeoutMs: 180_000 });
}