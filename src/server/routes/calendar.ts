import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import * as scheduleRepo from "../../db/content-schedule-repo.js";
import type { DbContentSchedule } from "../../db/types.js";

export const calendarRoutes = new Hono();

// GET / — list by date range
calendarRoutes.get("/", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ error: "from and to query params are required (YYYY-MM-DD)" }, 400);
  }
  const entries = scheduleRepo.listByDateRange(from, to);
  return c.json({ entries });
});

// GET /month/:yearMonth — list by month with counts
calendarRoutes.get("/month/:yearMonth", (c) => {
  const yearMonth = c.req.param("yearMonth");
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return c.json({ error: "yearMonth must be YYYY-MM format" }, 400);
  }
  const entries = scheduleRepo.listByMonth(yearMonth);
  const counts = scheduleRepo.getMonthCounts(yearMonth);
  return c.json({ entries, counts });
});

// GET /:id — get one
calendarRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const entry = scheduleRepo.getSchedule(id);
  if (!entry) return c.json({ error: "Schedule entry not found" }, 404);
  return c.json(entry);
});

// POST / — create
calendarRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    title: string;
    scheduled_date: string;
    work_id?: string;
    account_id?: string;
    description?: string;
    scheduled_time?: string;
    platform?: string;
    content_type?: string;
    status?: string;
    color?: string;
  }>();
  if (!body.title?.trim()) {
    return c.json({ error: "title is required" }, 400);
  }
  if (!body.scheduled_date) {
    return c.json({ error: "scheduled_date is required (YYYY-MM-DD)" }, 400);
  }
  const now = new Date().toISOString();
  const entry = scheduleRepo.createSchedule({
    id: randomUUID(),
    work_id: body.work_id,
    account_id: body.account_id,
    title: body.title.trim(),
    description: body.description ?? "",
    scheduled_date: body.scheduled_date,
    scheduled_time: body.scheduled_time,
    platform: body.platform ?? "",
    content_type: (body.content_type as DbContentSchedule["content_type"]) ?? "short-video",
    status: (body.status as DbContentSchedule["status"]) ?? "planned",
    color: body.color,
    created_at: now,
    updated_at: now,
  });
  return c.json(entry, 201);
});

// PUT /:id — update
calendarRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Partial<DbContentSchedule>>();
  const updates: Partial<DbContentSchedule> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.scheduled_date !== undefined) updates.scheduled_date = body.scheduled_date;
  if (body.scheduled_time !== undefined) updates.scheduled_time = body.scheduled_time;
  if (body.platform !== undefined) updates.platform = body.platform;
  if (body.content_type !== undefined) updates.content_type = body.content_type;
  if (body.status !== undefined) updates.status = body.status;
  if (body.color !== undefined) updates.color = body.color;
  if (body.description !== undefined) updates.description = body.description;
  if (body.work_id !== undefined) updates.work_id = body.work_id;
  if (body.account_id !== undefined) updates.account_id = body.account_id;

  const entry = scheduleRepo.updateSchedule(id, updates);
  if (!entry) return c.json({ error: "Schedule entry not found" }, 404);
  return c.json(entry);
});

// DELETE /:id — delete
calendarRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const deleted = scheduleRepo.deleteSchedule(id);
  if (!deleted) return c.json({ error: "Schedule entry not found" }, 404);
  return c.json({ deleted: true });
});

export default calendarRoutes;
