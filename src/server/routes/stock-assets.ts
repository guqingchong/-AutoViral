import { Hono } from "hono";
import { searchStockAssets, downloadStockAsset, getConfiguredStockProviders } from "../../services/stock-asset-service.js";
import type { StockProvider } from "../../services/stock-asset-service.js";

export const stockAssetRoutes = new Hono();

/** GET /api/stock-assets/search?q=...&type=image|video|all - search across Pexels（优先）/Pixabay/Unsplash */
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

/** GET /api/stock-assets/providers - list configured providers（按优先级排序，Pexels 优先） */
stockAssetRoutes.get("/providers", async (c) => {
  return c.json({ providers: await getConfiguredStockProviders() });
});

/** POST /api/stock-assets/download-batch - 批量并行下载(批次11.6,2026-08-31 实测:
 *  agent 逐个串行下载,素材搜索阶段 2h 的大头是下载串行等待。3 路并发,单项失败不影响其他) */
stockAssetRoutes.post("/download-batch", async (c) => {
  const body = await c.req.json<{
    items?: Array<{
      url: string; provider: StockProvider; mediaType?: "image" | "video";
      category?: string; name?: string; description?: string; author?: string; license?: string; duration?: number;
    }>;
  }>().catch(() => null);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required(每项同 /download 的字段)" }, 400);
  if (items.length > 20) return c.json({ error: "单次最多 20 项" }, 400);
  const results: Array<{ ok: boolean; name?: string; asset?: unknown; error?: string }> = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: 3 }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      const it = items[i];
      if (!it?.url || !it?.provider) { results[i] = { ok: false, name: it?.name, error: "url/provider 必填" }; continue; }
      try {
        const asset = await downloadStockAsset({
          url: it.url, provider: it.provider, mediaType: it.mediaType, category: it.category as never,
          name: it.name, description: it.description, author: it.author, license: it.license, duration: it.duration,
        });
        results[i] = { ok: true, name: it.name, asset };
      } catch (err) {
        results[i] = { ok: false, name: it.name, error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
  await Promise.all(workers);
  return c.json({ results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
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