/**
 * 模板调研学习（2026-08-03 Phase C 自进化）。
 *
 * 「模板调研学习」按钮的服务端实现：带着用户当前点选的要素，
 * 让带联网搜索能力的模型调研全网优秀短视频模板设计案例，
 * 蒸馏为可操作的设计技能存入 template_skills 表。之后每次生成模板时
 * 这些技能自动注入 prompt —— 模板生成能力随调研和使用持续进化。
 *
 * 2026-08-18 P3-T1：从 spawn Claude CLI（WebSearch 权限）切换为 LLM 直连——
 * research 阶段模型 + 平台内置搜索（Kimi $web_search，无内置搜索能力时退化无搜索单发）。
 */

import { loadConfig } from "../config.js";
import { resolveModelFor } from "../llm/registry.js";
import { PROVIDER_PRESETS } from "../llm/provider-keys.js";
import { chatJsonWithSearch } from "../llm/search-json.js";
import { addSkill, findSimilarSkill, touchSkill } from "../db/template-skills-repo.js";
import { CONTENT_FORMS, LAYOUTS, PALETTES, MOTIONS, DECORATIONS, type TemplateElements } from "./template-dna.js";

export interface ResearchResult {
  added: number;
  reused: number;
  skills: string[];
}

interface LlmSkillsResponse {
  skills?: Array<{ skill?: string; source?: string }>;
}

function labelOf(options: { key: string; label: string }[], key?: string): string {
  return options.find((o) => o.key === key)?.label ?? "不限";
}

/**
 * 调研学习主流程：按要素组合调研 → 蒸馏技能 → 去重入库。
 */
export async function researchTemplates(elements: TemplateElements = {}): Promise<ResearchResult> {
  const formLabel = labelOf(CONTENT_FORMS, elements.contentForm);
  const layoutLabel = labelOf(LAYOUTS, elements.layout);
  const paletteLabel = labelOf(PALETTES, elements.palette);
  const motionLabel = labelOf(MOTIONS, elements.motion);
  const decorationLabels = (elements.decorations ?? [])
    .map((k) => DECORATIONS.find((d) => d.key === k)?.label)
    .filter(Boolean)
    .join("、") || "不限";

  const prompt = [
    "你是短视频设计研究员。请用 WebSearch 调研全网优秀的短视频模板/视频排版设计案例，",
    "然后蒸馏成可执行的模板设计技能。",
    "",
    "## 调研方向（用户当前关注的模板要素）",
    `- 内容形式：${formLabel}（${elements.contentForm ?? "不限"}）`,
    `- 版式结构：${layoutLabel}`,
    `- 配色风格：${paletteLabel}`,
    `- 动效节奏：${motionLabel}`,
    `- 装饰元素：${decorationLabels}`,
    elements.freeText ? `- 用户补充：${elements.freeText}` : "",
    "",
    "## 调研要求",
    "1. 用中文和英文各搜索 2-3 轮（如：抖音 知识类视频 排版 模板 设计、viral short video text layout design、爆款 视频 封面 排版 技巧、motion graphic text template best practices）",
    "2. 优先采信：设计社区（站酷/Behance/新片场）的爆款拆解、平台官方创作指南、百万赞视频的共同视觉特征分析",
    "3. 不要泛泛的设计理论，要可立即执行的参数化结论",
    "",
    "## 蒸馏要求",
    "把调研结论压缩为 5-8 条技能，每条必须：",
    "- 一句话说清「做什么 + 为什么有效 + 具体参数」（如字号区间、配色 hex、留白比例、动效时长）",
    "- 针对 1080x1920 竖屏、纯文字+形状可实现的排版（不需要外部图片/视频素材）",
    "- 与该内容形式（" + formLabel + "）强相关",
    "",
    '输出: {"skills":[{"skill":"...","source":"调研来源简述"}]}',
  ].filter(Boolean).join("\n");

  const config = await loadConfig();
  const { provider, model } = resolveModelFor(config, "research");
  const builtinSearchTool = PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
  if (!builtinSearchTool) {
    console.warn(`[template-research] research 档 provider=${provider.name} 无内置搜索能力,退化为无搜索单发`);
  }
  const parsed = await chatJsonWithSearch<LlmSkillsResponse>(provider, model, prompt, {
    timeoutMs: 8 * 60_000,
    builtinSearchTool,
  });
  const rawSkills = (parsed?.skills ?? [])
    .map((s) => ({ skill: (s.skill ?? "").trim(), source: (s.source ?? "").trim() }))
    .filter((s) => s.skill.length >= 10);

  if (rawSkills.length === 0) {
    throw new Error("调研未产出有效技能（模型输出无法解析为技能列表）");
  }

  let added = 0;
  let reused = 0;
  const skills: string[] = [];
  for (const s of rawSkills) {
    const existing = findSimilarSkill(s.skill);
    if (existing) {
      touchSkill(existing.id); // 重复调研命中已有技能 → 增强其权重
      reused++;
    } else {
      addSkill({
        contentForm: elements.contentForm,
        elements: elements as Record<string, unknown>,
        skill: s.skill,
        source: s.source || undefined,
      });
      added++;
    }
    skills.push(s.skill);
  }
  return { added, reused, skills };
}
