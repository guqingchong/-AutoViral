import { Hono } from "hono";
import {
  listRules,
  updateRule,
  deleteRule,
} from "../../db/evolution-rules-repo.js";
import type { DbEvolutionRule } from "../../db/types.js";
import { generateRulesFromInsights } from "../../services/self-evolution.js";
import type { AnalysisInsight } from "../../services/hit-failure-analysis.js";

const evolutionRoutes = new Hono();

evolutionRoutes.get("/rules", (c) => {
  const ruleType = c.req.query("ruleType") as DbEvolutionRule["rule_type"] | undefined;
  return c.json(listRules(ruleType ? { ruleType } : undefined));
});

evolutionRoutes.patch("/rules/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const allowed: (keyof DbEvolutionRule)[] = [
    "enabled",
    "action",
    "confidence",
    "condition_json",
    "target_key",
  ];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k as keyof DbEvolutionRule))
  );
  const updated = updateRule(id, updates);
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated);
});

evolutionRoutes.delete("/rules/:id", (c) => {
  const id = Number(c.req.param("id"));
  const ok = deleteRule(id);
  return c.json({ ok });
});

evolutionRoutes.post("/generate", async (c) => {
  const body = await c.req.json();
  const insights = (body.insights ?? []) as AnalysisInsight[];
  const rules = await generateRulesFromInsights(insights);
  return c.json(rules);
});

export { evolutionRoutes };
