import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { buildPromptInjection, injectEvolution, recordRuleUsage } from "../../src/services/evolution-applier.js";
import { createRule } from "../../src/db/evolution-rules-repo.js";
import * as rulesRepo from "../../src/db/evolution-rules-repo.js";

describe("evolution-applier", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("builds topic prompt injection", () => {
    createRule({ rule_type: "topic", action: "优先焦虑类选题", confidence: 0.8, source: "test", enabled: true, condition_json: {} });
    const injection = buildPromptInjection("topic");
    expect(injection.prefix).toContain("优先焦虑类选题");
    expect(injection.appliedRules.length).toBe(1);
  });

  it("builds prompt injection", () => {
    createRule({ rule_type: "prompt", action: "加强钩子", confidence: 0.8, source: "test", enabled: true, condition_json: {} });
    const injection = buildPromptInjection("prompt");
    expect(injection.suffix).toContain("加强钩子");
  });

  it("filters out low-confidence rules", () => {
    createRule({ rule_type: "topic", action: "低置信", confidence: 0.3, source: "test", enabled: true, condition_json: {} });
    const injection = buildPromptInjection("topic");
    expect(injection.appliedRules.length).toBe(0);
  });

  it("injects evolution into a prompt", () => {
    const injection = buildPromptInjection("topic");
    const prompt = injectEvolution("基础提示", injection);
    expect(prompt).toContain("基础提示");
  });

  it("records rule usage", () => {
    const spy = vi.spyOn(rulesRepo, "incrementRuleAppliedCount").mockImplementation(() => undefined);
    const rule = createRule({ rule_type: "topic", action: "测试", confidence: 0.8, source: "test", enabled: true, condition_json: {} });
    recordRuleUsage([rule]);
    expect(spy).toHaveBeenCalledWith(rule.id);
  });
});
