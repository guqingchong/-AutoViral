import { Hono } from "hono";
import {
  recordDataSourceReference,
  listFixedDataSources,
  listDataSources,
  setFixedStatus,
  deleteDataSource,
} from "../../db/data-sources-repo.js";

export const dataSourceRoutes = new Hono();

/** GET /api/data-sources - list all tracked data sources */
dataSourceRoutes.get("/", (c) => {
  const fixed = c.req.query("fixed");
  const list = fixed === "1" || fixed === "true"
    ? listFixedDataSources()
    : listDataSources();
  return c.json({ dataSources: list });
});

/** GET /api/data-sources/fixed - list promoted (5+ references) sources */
dataSourceRoutes.get("/fixed", (c) => {
  return c.json({ dataSources: listFixedDataSources() });
});

/** POST /api/data-sources - record a reference to a data source */
dataSourceRoutes.post("/", async (c) => {
  const body = await c.req.json<{ url: string; platform?: string; title?: string }>();
  if (!body.url || typeof body.url !== "string") {
    return c.json({ error: "url is required" }, 400);
  }
  const source = recordDataSourceReference({
    url: body.url,
    platform: body.platform,
    title: body.title,
  });
  return c.json({ dataSource: source }, 201);
});

/** PUT /api/data-sources/:id/fixed - manually promote/demote */
dataSourceRoutes.put("/:id/fixed", async (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json<{ fixed: boolean }>();
  const ok = setFixedStatus(id, !!body.fixed);
  if (!ok) return c.json({ error: "Data source not found" }, 404);
  return c.json({ ok: true });
});

/** DELETE /api/data-sources/:id */
dataSourceRoutes.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const ok = deleteDataSource(id);
  if (!ok) return c.json({ error: "Data source not found" }, 404);
  return c.json({ ok: true });
});