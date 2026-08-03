import { Hono } from "hono";
import { searchStockAssets, downloadStockAsset, getConfiguredStockProviders } from "../../services/stock-asset-service.js";
import type { StockProvider } from "../../services/stock-asset-service.js";

export const stockAssetRoutes = new Hono();

/** GET /api/stock-assets/search?q=...&type=image|video|all - search across Openverse + Pexels/Pixabay/Unsplash */
stockAssetRoutes.get("/search", async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "Query parameter 'q' is required" }, 400);
  const providers = c.req.query("providers")?.split(",").filter(Boolean) as StockProvider[] | undefined;
  const perPage = Number(c.req.query("perPage")) || 15;
  const typeParam = c.req.query("type");
  const mediaType = typeParam === "image" || typeParam === "video" ? typeParam : "all";
  try {
    const results = await searchStockAssets(query, { providers, perPage, mediaType });
    return c.json({ results, providers: await getConfiguredStockProviders() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Search failed" }, 500);
  }
});

/** GET /api/stock-assets/providers - list configured providers (Openverse always available) */
stockAssetRoutes.get("/providers", async (c) => {
  return c.json({ providers: await getConfiguredStockProviders() });
});

/** POST /api/stock-assets/download - download a stock asset (image or video) into the library */
stockAssetRoutes.post("/download", async (c) => {
  const body = await c.req.json<{
    url: string;
    provider: StockProvider;
    mediaType?: "image" | "video";
    category?: string;
    name?: string;
    description?: string;
    author?: string;
    license?: string;
    duration?: number;
  }>();
  if (!body.url || !body.provider) {
    return c.json({ error: "url and provider are required" }, 400);
  }
  try {
    const asset = await downloadStockAsset({
      url: body.url,
      provider: body.provider,
      mediaType: body.mediaType,
      category: body.category as never,
      name: body.name,
      description: body.description,
      author: body.author,
      license: body.license,
      duration: body.duration,
    });
    return c.json({ asset }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Download failed" }, 500);
  }
});