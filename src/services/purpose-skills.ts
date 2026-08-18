/**
 * 用途技能包调研学习（2026-08-18 04 方案 第 1.5 层）。
 *
 * 选中用途/点"更新技能包"时：research 档模型 + 联网搜索调研该用途的
 * 最新爆款方法论（钩子公式/结构模板/话术/平台规则），蒸馏为技能条目
 * 存 purpose_skills 表。与 template-research 同模式：调研→蒸馏→去重入库。
 */

import { loadConfig } from "../config.js";
import { resolveModelFor } from "../llm/registry.js";
import { PROVIDER_PRESETS } from "../llm/provider-keys.js";
import { chatJsonWithSearch } from "../llm/search-json.js";
import { addPurposeSkill, countPurposeSkills } from "../db/purpose-skills-repo.js";
import { getPurpose } from "./purpose-presets.js";

export interface PurposeResearchResult {
  purpose: string;
  added: number;
  reused: number;
  total: number;
  skills: string[];
}

interface SkillsResponse {
  skills?: Array<{ skill?: string; source?: string }>;
}

export async function researchPurposeSkills(purposeKey: string): Promise<PurposeResearchResult> {
  const preset = getPurpose(purposeKey);
  if (!preset) throw new Error(`未知用途: ${purposeKey}`);

  const prompt = [
    `你是短视频爆款方法论研究员。请用联网搜索调研「${preset.label}」（目标：${preset.goal}）这一用途的`,
    `最新（2025-2026）抖音/小红书/B站爆款创作方法论，蒸馏成可直接执行的制作技能。`,
    "",
    `## 用途背景`,
    `- 内容策略：${preset.strategy}`,
    `- 主力形式：${preset.forms.join("、")}`,
    `- 当前已有技能 ${countPurposeSkills(purposeKey)} 条，请调研增量与新趋势，避免泛泛常识`,
    "",
    "## 调研方向（每个方向搜 1-2 轮）",
    `1. ${preset.label}赛道的爆款视频结构拆解（开头钩子/中段展开/结尾 CTA 的时间点设计）`,
    `2. 该用途的标题/封面/前 3 秒话术公式`,
    `3. 平台算法对该用途内容的偏好与限流红线（2025-2026 最新）`,
    `4. 头部账号的可复制手法（具体到参数：时长/字幕密度/BGM 类型/节奏点）`,
    "",
    "## 蒸馏要求",
    "压缩为 8-12 条技能，每条必须：",
    "- 一句话说清「做什么 + 为什么有效 + 具体参数」（如时间点/字数/占比）",
    "- 可直接注入 AI 制作管线的 prompt 执行，不要空泛理论",
    `- 与「${preset.label}」强相关，通用于任何选题`,
    "",
    '输出: {"skills":[{"skill":"...","source":"调研来源简述"}]}',
  ].join("\n");

  const config = await loadConfig();
  const { provider, model } = resolveModelFor(config, "research");
  const builtinSearchTool = PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
  const parsed = await chatJsonWithSearch<SkillsResponse>(provider, model, prompt, {
    timeoutMs: 8 * 60_000,
    maxRounds: 12,
    builtinSearchTool,
  });

  const rawSkills = (parsed?.skills ?? [])
    .map((s) => ({ skill: (s.skill ?? "").trim(), source: (s.source ?? "").trim() }))
    .filter((s) => s.skill.length >= 10);
  if (!rawSkills.length) throw new Error("调研未产出有效技能");

  let added = 0;
  let reused = 0;
  const skills: string[] = [];
  for (const s of rawSkills) {
    const r = addPurposeSkill({ purpose: purposeKey, skill: s.skill, source: s.source || undefined });
    if (r.added) added++; else reused++;
    skills.push(s.skill);
  }
  return { purpose: purposeKey, added, reused, total: countPurposeSkills(purposeKey), skills };
}
