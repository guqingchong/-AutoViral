import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createRule } from "../../src/db/evolution-rules-repo.js";
import { evolutionRoutes } from "../../src/server/routes/evolution.js";

function setupApp() {
  const app = new Hono();
  app.route("/api/evolution", evolutionRoutes);
  return app;
}

describe("evolution routes", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("lists rules", async () => {
    createRule({
      rule_type: "topic",
      action: "优先焦虑",
      confidence: 0.8,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    const res = await setupApp().request("/api/evolution/rules");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
  });

  it("lists rules empty when no rules exist", async () => {
    const res = await setupApp().request("/api/evolution/rules");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it("filters rules by rule type", async () => {
    createRule({
      rule_type: "topic",
      action: "优先焦虑",
      confidence: 0.8,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    createRule({
      rule_type: "hook",
      action: "使用反转钩子",
      confidence: 0.7,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    const res = await setupApp().request("/api/evolution/rules?ruleType=hook");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].rule_type).toBe("hook");
  });

  it("toggles rule enabled state", async () => {
    const rule = createRule({
      rule_type: "topic",
      action: "优先焦虑",
      confidence: 0.8,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    const res = await setupApp().request(`/api/evolution/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.enabled).toBe(false);
  });

  it("updates rule confidence", async () => {
    const rule = createRule({
      rule_type: "style",
      action: "增强视觉冲击",
      confidence: 0.6,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    const res = await setupApp().request(`/api/evolution/rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confidence: 0.9 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.confidence).toBe(0.9);
  });

  it("deletes a rule", async () => {
    const rule = createRule({
      rule_type: "timing",
      action: "晚间发布",
      confidence: 0.65,
      source: "test",
      enabled: true,
      condition_json: {},
    });
    const res = await setupApp().request(`/api/evolution/rules/${rule.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // verify deleted
    const listRes = await setupApp().request("/api/evolution/rules");
    const listData = await listRes.json();
    expect(listData.length).toBe(0);
  });

  it("PATCH non-existent rule returns 404", async () => {
    const res = await setupApp().request("/api/evolution/rules/99999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE non-existent rule is idempotent (returns 200)", async () => {
    const res = await setupApp().request("/api/evolution/rules/99999", { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = await res.json();
    // deleteRule returns false for non-existent, route passes through as { ok: false }
    expect(typeof data.ok).toBe("boolean");
  });
});
