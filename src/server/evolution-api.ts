/**
 * Phase 5 Evolution API — self-evolution rules management.
 * Mounted at /api/evolution/.
 */

import { Hono } from "hono";
import {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  incrementRuleAppliedCount,
} from "../db/evolution-rules-repo.js";
import { getActiveRules, evolveFromPerformance } from "../services/self-evolution.js";
import { buildPromptInjection } from "../services/evolution-applier.js";
import { analyzeWork } from "../services/hit-failure-analysis.js";
import { getPublishRecord } from "../db/publish-records-repo.js";
import { getWork } from "../work-store.js";

export const evolutionApi = new Hono();

// GET /api/evolution/rules
evolutionApi.get("/rules", (c) => {
  const ruleType = c.req.query("type");
  const enabled = c.req.query("enabled");
  const rules = listRules({
    ...(ruleType ? { ruleType: ruleType as any } : {}),
    ...(enabled !== undefined ? { enabled: enabled === "true" } : {}),
  });
  return c.json({ rules });
});

// GET /api/evolution/rules/active
evolutionApi.get("/rules/active", (c) => {
  const type = c.req.query("type");
  const rules = getActiveRules(type as any);
  return c.json({ rules });
});

// GET /api/evolution/rules/:id
evolutionApi.get("/rules/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const rule = getRule(id);
  if (!rule) return c.json({ error: "Rule not found" }, 404);
  return c.json(rule);
});

// POST /api/evolution/rules
evolutionApi.post("/rules", async (c) => {
  const body = await c.req.json<{
    rule_type: string;
    target_key?: string;
    condition_json: Record<string, unknown>;
    action: string;
    confidence: number;
    source: string;
  }>();
  if (!body.rule_type || !body.action) {
    return c.json({ error: "rule_type and action are required" }, 400);
  }
  const rule = createRule({
    rule_type: body.rule_type as any,
    target_key: body.target_key,
    condition_json: body.condition_json ?? {},
    action: body.action,
    confidence: body.confidence ?? 0.5,
    source: body.source ?? "manual",
    enabled: true,
  });
  return c.json(rule, 201);
});

// PUT /api/evolution/rules/:id
evolutionApi.put("/rules/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json<{
    enabled?: boolean;
    confidence?: number;
    action?: string;
  }>();
  const updated = updateRule(id, body);
  if (!updated) return c.json({ error: "Rule not found" }, 404);
  return c.json(updated);
});

// DELETE /api/evolution/rules/:id
evolutionApi.delete("/rules/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const deleted = deleteRule(id);
  if (!deleted) return c.json({ error: "Rule not found" }, 404);
  return c.json({ deleted: true });
});

// POST /api/evolution/rules/:id/apply — record usage
evolutionApi.post("/rules/:id/apply", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  incrementRuleAppliedCount(id);
  return c.json({ applied: true });
});

// POST /api/evolution/analyze/:recordId — trigger evolution from a publish record
evolutionApi.post("/analyze/:recordId", async (c) => {
  const recordId = parseInt(c.req.param("recordId"), 10);
  const record = getPublishRecord(recordId);
  if (!record) return c.json({ error: "Publish record not found" }, 404);

  const analysis = analyzeWork(recordId);
  if (!analysis) return c.json({ error: "Insufficient metrics for analysis" }, 400);

  const work = await getWork(record.work_id);
  if (!work) return c.json({ error: "Work not found" }, 404);

  try {
    const rules = await evolveFromPerformance({
      analysis,
      workTitle: work.title,
      tags: (work as any).platforms ?? [],
    });
    return c.json({ analysis, rules });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// GET /api/evolution/injection — preview prompt injection for a rule type
evolutionApi.get("/injection", (c) => {
  const type = c.req.query("type") ?? "prompt";
  const injection = buildPromptInjection(type as any);
  return c.json(injection);
});
