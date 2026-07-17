/**
 * Stock asset search & download (PRD §4.2 合规素材中台).
 *
 * Integrates:
 *   - Openverse (https://api.openverse.org) — FREE, NO API KEY required. Default source.
 *   - Pexels (photos/videos) — free, requires API key (config.pexels.apiKey)
 *   - Pixabay (photos/videos) — free, requires API key (config.pixabay.apiKey)
 *   - Unsplash (photos) — free, requires API key (config.unsplash.accessKey)
 *
 * Openverse aggregates CC-licensed content from 50+ sources and works immediately
 * without any registration, so users can search right away. The key-based providers
 * are optional additions for higher quality / larger libraries.
 */

import { loadConfig } from "../config.js";
import { uploadAsset } from "./asset-library.js";
import type { DbAssetCategory } from "../db/types.js";

export type StockProvider = "openverse" | "pexels" | "pixabay" | "unsplash";

export interface StockSearchItem {
  provider: StockProvider;
  id: string;
  url: string; // direct asset URL
  previewUrl?: string;
  width?: number;
  height?: number;
  author?: string;
  description?: string;
  license?: string;
}

export interface StockSearchResult {
  items: StockSearchItem[];
  total: number;
  provider: string;
}

let configCache: Awaited<ReturnType<typeof loadConfig>> | undefined;
async function loadConfigCached() {
  if (!configCache) configCache = await loadConfig();
  return configCache;
}

// ── Openverse (free, no API key) ───────────────────────────────────────────

async function searchOpenverse(query: string, perPage: number): Promise<StockSearchItem[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${perPage}&mature=false`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Openverse search failed: ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{
      id: string;
      url?: string;
      thumbnail?: string;
      width?: number;
      height?: number;
      creator?: string;
      title?: string;
      license?: string;
      license_version?: string;
    }>;
  };
  return (data.results ?? [])
    .filter((r) => r.url) // only items with a direct image URL
    .map((r) => ({
      provider: "openverse" as const,
      id: r.id,
      url: r.url!,
      previewUrl: r.thumbnail,
      width: r.width,
      height: r.height,
      author: r.creator,
      description: r.title,
      license: r.license ? `${r.license}${r.license_version ? " " + r.license_version : ""}` : "cc",
    }));
}

// ── Pexels (free, requires API key) ────────────────────────────────────────

async function searchPexels(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfigCached();
  const key = config.pexels?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
    headers: { Authorization: key }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Pexels search failed: ${res.status}`);
  const data = (await res.json()) as { photos?: Array<{ id: number; src: { large2x: string; medium: string }; width?: number; height?: number; photographer?: string; alt?: string }> };
  return (data.photos ?? []).map((p) => ({
    provider: "pexels" as const,
    id: String(p.id),
    url: p.src.large2x,
    previewUrl: p.src.medium,
    width: p.width,
    height: p.height,
    author: p.photographer,
    description: p.alt,
    license: "Pexels License (commercial OK)",
  }));
}

// ── Pixabay (free, requires API key) ────────────────────────────────────────

async function searchPixabay(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfigCached();
  const key = config.pixabay?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPage}&image_type=all`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Pixabay search failed: ${res.status}`);
  const data = (await res.json()) as { hits?: Array<{ id: number; largeImageURL: string; previewURL: string; imageWidth?: number; imageHeight?: number; user?: string; tags?: string }> };
  return (data.hits ?? []).map((h) => ({
    provider: "pixabay" as const,
    id: String(h.id),
    url: h.largeImageURL,
    previewUrl: h.previewURL,
    width: h.imageWidth,
    height: h.imageHeight,
    author: h.user,
    description: h.tags,
    license: "Pixabay License (commercial OK)",
  }));
}

// ── Unsplash (free, requires API key) ─────────────────────────────────────

async function searchUnsplash(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfigCached();
  const key = config.unsplash?.accessKey;
  if (!key) return [];
  const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
    headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Unsplash search failed: ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ id: string; urls: { full: string; small: string }; width?: number; height?: number; user?: { name?: string }; alt_description?: string }> };
  return (data.results ?? []).map((r) => ({
    provider: "unsplash" as const,
    id: r.id,
    url: r.urls.full,
    previewUrl: r.urls.small,
    width: r.width,
    height: r.height,
    author: r.user?.name,
    description: r.alt_description,
    license: "Unsplash License (commercial OK)",
  }));
}

export interface MultiSearchOptions {
  providers?: StockProvider[];
  perPage?: number;
}

/**
 * Search across stock providers. Openverse is always included (no key needed);
 * key-based providers are added when configured.
 */
export async function searchStockAssets(query: string, options: MultiSearchOptions = {}): Promise<StockSearchResult[]> {
  const allProviders: StockProvider[] = ["openverse", "pexels", "pixabay", "unsplash"];
  const providers = options.providers ?? allProviders;
  const perPage = Math.min(options.perPage ?? 15, 50);
  const results: StockSearchResult[] = [];

  const tasks = providers.map(async (provider) => {
    try {
      let items: StockSearchItem[] = [];
      if (provider === "openverse") items = await searchOpenverse(query, perPage);
      else if (provider === "pexels") items = await searchPexels(query, perPage);
      else if (provider === "pixabay") items = await searchPixabay(query, perPage);
      else if (provider === "unsplash") items = await searchUnsplash(query, perPage);
      if (items.length > 0) results.push({ provider, items, total: items.length });
    } catch (err) {
      console.error(`[stock-asset] ${provider} search error:`, err instanceof Error ? err.message : err);
    }
  });
  await Promise.all(tasks);
  return results;
}

export interface StockDownloadInput {
  url: string;
  provider: StockProvider;
  category?: DbAssetCategory;
  name?: string;
  description?: string;
  author?: string;
  license?: string;
}

/**
 * Download a stock asset by URL and import it into the local asset library
 * with proper license/compliance metadata.
 */
export async function downloadStockAsset(input: StockDownloadInput) {
  const category = input.category ?? "scenes";
  const licenseMap: Record<string, "cc0" | "commercial"> = {
    openverse: "cc0",
    pexels: "commercial",
    pixabay: "cc0",
    unsplash: "commercial",
  };
  const asset = await uploadAsset({
    name: input.name ?? `stock_${input.provider}_${Date.now()}.jpg`,
    data: Buffer.from(await (await fetch(input.url)).arrayBuffer()),
    category,
    type: "image",
    source: input.provider as "pexels" | "pixabay" | "unsplash",
    license: licenseMap[input.provider],
    tags: [input.provider],
    metadata: {
      author: input.author,
      description: input.description,
      sourceUrl: input.url,
      license: input.license,
    },
  });
  return asset;
}

/** Returns which stock providers are configured (Openverse is always available). */
export async function getConfiguredStockProviders(): Promise<StockProvider[]> {
  const config = await loadConfigCached();
  const out: StockProvider[] = ["openverse"]; // always available, no key
  if (config.pexels?.apiKey) out.push("pexels");
  if (config.pixabay?.apiKey) out.push("pixabay");
  if (config.unsplash?.accessKey) out.push("unsplash");
  return out;
}