/**
 * Self-evolution engine.
 *
 * Generates evolution rules by analyzing performance patterns:
 * 1. Identifies hit patterns → reinforces successful elements
 * 2. Identifies failure patterns → suggests corrective actions
 * 3. Stores rules as DbEvolutionRule records for prompt injection
 */

import { createRule, listRules } from "../db/evolution-rules-repo.js";
import { runJsonPrompt } from "./llm-json.js";
import type { WorkAnalysis } from "./hit-failure-analysis.js";
import type { DbEvolutionRule } from "../db/types.js";

export interface EvolutionInput {
  /** The hit/failure analysis for the work */
  analysis: WorkAnalysis;
  /** The work title (for context) */
  workTitle: string;
  /** Content tags used */
  tags: string[];
  /** Emotion type used */
  emotionType?: string;
  /** Hook type used */
  hookType?: string;
}

/**
 * Generate evolution rules from a work's performance analysis.
 * Hits → reinforce; Failures → correct.
 */
export async function evolveFromPerformance(input: EvolutionInput): Promise<DbEvolutionRule[]> {
  const { analysis, workTitle, tags, emotionType, hookType } = input;

  const prompt = [
    "你是一个内容策略分析引擎。根据以下作品的表现数据，生成改进规则。",
    "",
    `作品标题：${workTitle}`,
    `表现判定：${analysis.verdict}`,
    `播放量：${analysis.actual.views}（基准 ${analysis.baselines.views}，比率 ${analysis.viewsRatio.toFixed(2)}x）`,
    `点赞量：${analysis.actual.likes}（基准 ${analysis.baselines.likes}，比率 ${analysis.likesRatio.toFixed(2)}x）`,
    `标签：${tags.join(", ")}`,
    `情绪类型：${emotionType ?? "未知"}`,
    `Hook类型：${hookType ?? "未知"}`,
    "",
    analysis.verdict === "hit"
      ? "这是一条爆款内容。分析成功因素，生成「强化规则」来复用这些模式。"
      : analysis.verdict === "failure"
        ? "这是一条失败内容。分析失败原因，生成「修正规则」来避免类似问题。"
        : "这是一条表现一般的内容。生成微调建议。",
    "",
    `输出 JSON：{"rules":[{"rule_type":"topic|prompt|template","target_key":"标签/情绪/hook","condition_json":{"field":"值"},"action":"操作描述","confidence":0.8}]}`,
    "rule_type：topic(选题)/prompt(提示词)/template(模板)。confidence 范围 0.0-1.0。",
  ].join("\n");

  const result = await runJsonPrompt<{
    rules: Array<{
      rule_type: string;
      target_key?: string;
      condition_json: Record<string, unknown>;
      action: string;
      confidence: number;
    }>;
  }>(prompt, { timeoutMs: 120_000 });

  const created: DbEvolutionRule[] = [];

  for (const r of result.rules ?? []) {
    const ruleType = normalizeRuleType(r.rule_type);
    const rule = createRule({
      rule_type: ruleType,
      target_key: r.target_key,
      condition_json: r.condition_json ?? {},
      action: r.action,
      confidence: Math.min(1, Math.max(0, r.confidence)),
      source: `auto-evolution:${analysis.verdict}`,
      enabled: r.confidence >= 0.6,
    });
    created.push(rule);
    console.log(
      `[self-evolution] created rule #${rule.id} type=${rule.rule_type} confidence=${rule.confidence} action=${rule.action.slice(0, 40)}`
    );
  }

  return created;
}

function normalizeRuleType(raw: string): DbEvolutionRule["rule_type"] {
  const map: Record<string, DbEvolutionRule["rule_type"]> = {
    topic: "topic",
    template: "template",
    prompt: "prompt",
    publish_time: "publish_time",
    platform: "platform",
  };
  return map[raw] ?? "prompt";
}

/**
 * Get active evolution rules, sorted by confidence.
 */
export function getActiveRules(type?: DbEvolutionRule["rule_type"]): DbEvolutionRule[] {
  return listRules({ enabled: true, ...(type ? { ruleType: type } : {}) });
}
