/**
 * Evolution rule applier.
 *
 * Injects active evolution rules into generation prompts.
 * Called by content-generator, topic-researcher, and script-writer.
 */

import { getActiveRules } from "./self-evolution.js";
import { incrementRuleAppliedCount } from "../db/evolution-rules-repo.js";
import type { DbEvolutionRule } from "../db/types.js";

export interface PromptInjection {
  /** Text to prepend to the prompt (system instructions) */
  prefix?: string;
  /** Text to append to the prompt (additional constraints) */
  suffix?: string;
  /** Specific rules applied */
  appliedRules: DbEvolutionRule[];
}

/**
 * Build prompt injection from active evolution rules.
 * Filters rules by type for the specific generation context.
 */
export function buildPromptInjection(ruleType: DbEvolutionRule["rule_type"]): PromptInjection {
  const rules = getActiveRules(ruleType);
  const appliedRules: DbEvolutionRule[] = [];

  const prefixLines: string[] = [];
  const suffixLines: string[] = [];

  for (const rule of rules) {
    if (rule.confidence < 0.5) continue;

    appliedRules.push(rule);

    if (ruleType === "topic") {
      // Topic rules: guide selection criteria
      prefixLines.push(`- ${rule.action}`);
    } else if (ruleType === "prompt") {
      // Prompt rules: modify generation instructions
      suffixLines.push(`【进化规则】${rule.action}`);
    } else if (ruleType === "template") {
      // Template rules: modify structure
      suffixLines.push(`【模板优化】${rule.action}`);
    }
  }

  return {
    prefix: prefixLines.length > 0 ? prefixLines.join("\n") : undefined,
    suffix: suffixLines.length > 0 ? suffixLines.join("\n") : undefined,
    appliedRules,
  };
}

/**
 * Inject evolution guidance into a base prompt string.
 * Returns the augmented prompt.
 */
export function injectEvolution(prompt: string, injection: PromptInjection): string {
  const parts: string[] = [];
  if (injection.prefix) parts.push(injection.prefix);
  parts.push(prompt);
  if (injection.suffix) parts.push(injection.suffix);
  return parts.join("\n\n");
}

/**
 * Mark all applied rules as used (increments applied_count).
 */
export function recordRuleUsage(appliedRules: DbEvolutionRule[]): void {
  for (const rule of appliedRules) {
    incrementRuleAppliedCount(rule.id);
  }
}
