import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { evolveFromPerformance, getActiveRules } from "../../src/services/self-evolution.js";
import * as llmJson from "../../src/services/llm-json.js";
import type { WorkAnalysis } from "../../src/services/hit-failure-analysis.js";

describe("self-evolution", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  const analysis: WorkAnalysis = {
    publishRecordId: 1,
    verdict: "hit",
    viewsRatio: 4,
    likesRatio: 3,
    baselines: { views: 100, likes: 10, comments: 3, shares: 2 },
    actual: { views: 400, likes: 30, comments: 5, shares: 4 },
  };

  it("creates evolution rules from LLM output", async () => {
    vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
      rules: [
        { rule_type: "topic", target_key: "焦虑", condition_json: { emotion: "焦虑" }, action: "优先焦虑类选题", confidence: 0.85 },
      ],
    });

    const rules = await evolveFromPerformance({ analysis, workTitle: "Test", tags: ["焦虑"], emotionType: "焦虑", hookType: "危机" });
    expect(rules.length).toBe(1);
    expect(rules[0].rule_type).toBe("topic");
    expect(rules[0].enabled).toBe(true);
  });

  it("disables low-confidence rules", async () => {
    vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
      rules: [
        { rule_type: "prompt", condition_json: {}, action: "测试", confidence: 0.4 },
      ],
    });

    const rules = await evolveFromPerformance({ analysis, workTitle: "Test", tags: [] });
    expect(rules[0].enabled).toBe(false);
  });

  it("lists active rules", async () => {
    vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
      rules: [
        { rule_type: "topic", condition_json: {}, action: "活跃规则", confidence: 0.9 },
      ],
    });
    await evolveFromPerformance({ analysis, workTitle: "Test", tags: [] });
    const active = getActiveRules("topic");
    expect(active.length).toBe(1);
    expect(active[0].action).toBe("活跃规则");
  });
});
