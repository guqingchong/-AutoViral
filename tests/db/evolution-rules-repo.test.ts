import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createRule, listRules, updateRule } from "../../src/db/evolution-rules-repo.js";

describe("evolution-rules-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and filters rules", () => {
    createRule({ rule_type: "topic", action: "优先焦虑类选题", confidence: 0.8, source: "hit_analysis", enabled: true, condition_json: {} });
    createRule({ rule_type: "template", action: "使用高对比封面", confidence: 0.6, source: "manual", enabled: false, condition_json: {} });
    expect(listRules({ enabled: true }).length).toBe(1);
    expect(listRules({ ruleType: "topic" }).length).toBe(1);
  });

  it("updates enabled state", () => {
    const r = createRule({ rule_type: "prompt", action: "加强钩子", confidence: 0.7, source: "hit_analysis", enabled: true, condition_json: {} });
    const updated = updateRule(r.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
  });
});
