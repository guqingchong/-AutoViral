import { Hono } from "hono";
import { getBudgetStatus, setBudgetLimits } from "../../services/budget-service.js";

export const budgetRoutes = new Hono();

/** GET /api/budget - current monthly budget status */
budgetRoutes.get("/", (c) => {
  return c.json(getBudgetStatus());
});

/** PUT /api/budget - update budget limits */
budgetRoutes.put("/", async (c) => {
  const body = await c.req.json<{
    monthlyLimitYuan?: number;
    dailyLimitYuan?: number;
    warningThresholdPercent?: number;
  }>();
  await setBudgetLimits(body);
  return c.json(getBudgetStatus());
});