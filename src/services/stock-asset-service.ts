/**
 * Stock asset search & download (PRD §4.2 合规素材中台).
 *
 * Integrates:
 *   - Openverse (https://api.openverse.org) — FREE, NO API KEY required. Default source. (图片)
 *   - Pexels (photos/videos) — free, requires API key (config.pexels.apiKey)（图片 + 视频）
 *   - Pixabay (photos/videos) — free, requires API key (config.pixabay.apiKey)（图片 + 视频）
 *   - Unsplash (photos) — free, requires API key (config.unsplash.accessKey)（仅图片）
 *
 * Openverse aggregates CC-licensed content from 50+ sources and works immediately
 * without any registration, so users can search right away. The key-based providers
 * are optional additions for higher quality / larger libraries.
 *
 * 视频素材：Pexels/Pixabay 的视频 API 与图片共用同一个免费 Key。
 * 搜索结果带 mediaType/duration/宽高，供 LLM 在工作流"素材准备"步骤按
 * 竖版优先、分辨率、时长、语义贴合度打分选优（2026-08-03 工作流嵌入改造）。
 */

import { loadConfig } from "../config.js";
import { uploadAsset } from "./asset-library.js";
import type { DbAssetCategory } from "../db/types.js";

export type StockProvider = "openverse" | "pexels" | "pixabay" | "unsplash";
export type StockMediaType = "image" | "video";

export interface StockSearchItem {
  provider: StockProvider;
  id: string;
  mediaType: StockMediaType;
  url: string; // direct asset URL
  previewUrl?: string;
  width?: number;
  height?: number;
  /** 视频时长（秒），图片无此字段 */
  duration?: number;
  author?: string;
  description?: string;
  license?: string;
}

export interface StockSearchResult {
  items: StockSearchItem[];
  total: number;
  provider: string;
  /** 该源搜索失败时的错误信息（如网络不可达、API Key 无效） */
  error?: string;
}

// 注意：本模块不得缓存 config。此前模块级 configCache 导致"设置页填入 API Key
// 后必须重启服务器才生效"，用户看到"已填 key 但显示未连通"——2026-07-21 根因。
// loadConfig() 每次调用都重新读取 yaml，直接用它即可。

// ── Openverse (free, no API key) ───────────────────────────────────────────

async function searchOpenverse(query: string, perPage: number): Promise<StockSearchItem[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${perPage}&mature=false`;
  // 6s 超时：api.openverse.org 在国内网络下普遍不可达，快速失败避免拖累整体搜索
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Openverse 搜索失败 (HTTP ${res.status})`);
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
      mediaType: "image" as const,
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
  const config = await loadConfig();
  const key = config.pexels?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
    headers: { Authorization: key }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Pexels API Key 无效（HTTP ${res.status}），请检查设置页 Key 是否正确` : `Pexels 搜索失败 (HTTP ${res.status})`);
  const data = (await res.json()) as { photos?: Array<{ id: number; src: { large2x: string; medium: string }; width?: number; height?: number; photographer?: string; alt?: string }> };
  return (data.photos ?? []).map((p) => ({
    provider: "pexels" as const,
    id: String(p.id),
    mediaType: "image" as const,
    url: p.src.large2x,
    previewUrl: p.src.medium,
    width: p.width,
    height: p.height,
    author: p.photographer,
    description: p.alt,
    license: "Pexels License (commercial OK)",
  }));
}

interface PexelsVideoFile {
  id: number;
  quality?: string;
  file_type?: string;
  width?: number | null;
  height?: number | null;
  link?: string;
}

/** 从 Pexels video_files 里选最适合二次创作的文件：mp4 优先，宽度 ≤1920 中取最大 */
function pickPexelsVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | undefined {
  const candidates = files.filter((f) => f.link && (f.file_type ?? "").includes("mp4"));
  if (candidates.length === 0) return undefined;
  const le1080p = candidates.filter((f) => (f.width ?? 0) <= 1920);
  const pool = le1080p.length > 0 ? le1080p : candidates;
  return pool.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
}

async function searchPexelsVideos(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfig();
  const key = config.pexels?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
    headers: { Authorization: key }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Pexels API Key 无效（HTTP ${res.status}），请检查设置页 Key 是否正确` : `Pexels 视频搜索失败 (HTTP ${res.status})`);
  const data = (await res.json()) as {
    videos?: Array<{
      id: number;
      width?: number;
      height?: number;
      duration?: number;
      image?: string;
      user?: { name?: string };
      video_files?: PexelsVideoFile[];
    }>;
  };
  return (data.videos ?? [])
    .map((v): StockSearchItem | undefined => {
      const file = pickPexelsVideoFile(v.video_files ?? []);
      if (!file?.link) return undefined;
      return {
        provider: "pexels",
        id: String(v.id),
        mediaType: "video",
        url: file.link,
        previewUrl: v.image,
        width: file.width ?? v.width,
        height: file.height ?? v.height,
        duration: v.duration,
        author: v.user?.name,
        license: "Pexels License (commercial OK)",
      };
    })
    .filter((x): x is StockSearchItem => x !== undefined);
}

// ── Pixabay (free, requires API key) ────────────────────────────────────────

async function searchPixabay(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfig();
  const key = config.pixabay?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPage}&image_type=all`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 || res.status === 400 ? `Pixabay API Key 无效（HTTP ${res.status}），请检查设置页 Key 是否正确` : `Pixabay 搜索失败 (HTTP ${res.status})`);
  const data = (await res.json()) as { hits?: Array<{ id: number; largeImageURL: string; previewURL: string; imageWidth?: number; imageHeight?: number; user?: string; tags?: string }> };
  return (data.hits ?? []).map((h) => ({
    provider: "pixabay" as const,
    id: String(h.id),
    mediaType: "image" as const,
    url: h.largeImageURL,
    previewUrl: h.previewURL,
    width: h.imageWidth,
    height: h.imageHeight,
    author: h.user,
    description: h.tags,
    license: "Pixabay License (commercial OK)",
  }));
}

interface PixabayVideoVariant {
  url?: string;
  width?: number;
  height?: number;
}

async function searchPixabayVideos(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfig();
  const key = config.pixabay?.apiKey;
  if (!key) return [];
  const res = await fetch(`https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&per_page=${perPage}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 || res.status === 400 ? `Pixabay API Key 无效（HTTP ${res.status}），请检查设置页 Key 是否正确` : `Pixabay 视频搜索失败 (HTTP ${res.status})`);
  const data = (await res.json()) as {
    hits?: Array<{
      id: number;
      duration?: number;
      user?: string;
      tags?: string;
      picture_id?: string;
      videos?: { large?: PixabayVideoVariant; medium?: PixabayVideoVariant; small?: PixabayVideoVariant; tiny?: PixabayVideoVariant };
    }>;
  };
  return (data.hits ?? [])
    .map((h): StockSearchItem | undefined => {
      // large 常为 4K，优先 medium（≤1080p）减小下载与转码压力；没有则取可用最大档
      const variants = h.videos ?? {};
      const chosen = variants.medium?.url ? variants.medium
        : variants.large?.url ? variants.large
        : variants.small?.url ? variants.small
        : variants.tiny;
      if (!chosen?.url) return undefined;
      return {
        provider: "pixabay",
        id: String(h.id),
        mediaType: "video",
        url: chosen.url,
        previewUrl: h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : undefined,
        width: chosen.width,
        height: chosen.height,
        duration: h.duration,
        author: h.user,
        description: h.tags,
        license: "Pixabay License (commercial OK)",
      };
    })
    .filter((x): x is StockSearchItem => x !== undefined);
}

// ── Unsplash (free, requires API key) ─────────────────────────────────────

async function searchUnsplash(query: string, perPage: number): Promise<StockSearchItem[]> {
  const config = await loadConfig();
  const key = config.unsplash?.accessKey;
  if (!key) return [];
  const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
    headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? `Unsplash Access Key 无效（HTTP ${res.status}），请检查设置页 Key 是否正确` : `Unsplash 搜索失败 (HTTP ${res.status})`);
  const data = (await res.json()) as { results?: Array<{ id: string; urls: { full: string; small: string }; width?: number; height?: number; user?: { name?: string }; alt_description?: string }> };
  return (data.results ?? []).map((r) => ({
    provider: "unsplash" as const,
    id: r.id,
    mediaType: "image" as const,
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
  /**
   * 媒体类型过滤：image 只搜图片，video 只搜视频，all（默认）两者都搜。
   * Openverse / Unsplash 没有视频库，mediaType=video 时自动跳过。
   */
  mediaType?: StockMediaType | "all";
}

/**
 * Search across stock providers. Openverse is always included (no key needed);
 * key-based providers are added when configured.
 * Pexels / Pixabay 的图片与视频 API 共用同一个 Key，mediaType 控制搜哪类。
 */
export async function searchStockAssets(query: string, options: MultiSearchOptions = {}): Promise<StockSearchResult[]> {
  const allProviders: StockProvider[] = ["openverse", "pexels", "pixabay", "unsplash"];
  const providers = options.providers ?? allProviders;
  const mediaType = options.mediaType ?? "all";
  const perPage = Math.min(options.perPage ?? 15, 50);
  const results: StockSearchResult[] = [];

  const tasks = providers.map(async (provider) => {
    try {
      let items: StockSearchItem[] = [];
      const wantImage = mediaType !== "video";
      const wantVideo = mediaType !== "image";
      if (provider === "openverse") {
        if (wantImage) items = await searchOpenverse(query, perPage);
      } else if (provider === "pexels") {
        const [images, videos] = await Promise.all([
          wantImage ? searchPexels(query, perPage) : Promise.resolve([]),
          wantVideo ? searchPexelsVideos(query, perPage) : Promise.resolve([]),
        ]);
        items = [...videos, ...images]; // 视频在前，短视频工作流更关心视频
      } else if (provider === "pixabay") {
        const [images, videos] = await Promise.all([
          wantImage ? searchPixabay(query, perPage) : Promise.resolve([]),
          wantVideo ? searchPixabayVideos(query, perPage) : Promise.resolve([]),
        ]);
        items = [...videos, ...images];
      } else if (provider === "unsplash") {
        if (wantImage) items = await searchUnsplash(query, perPage);
      }
      if (items.length > 0) results.push({ provider, items, total: items.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[stock-asset] ${provider} search error:`, message);
      // 错误随结果返回，前端按源展示（如 Openverse 网络不可达 / API Key 无效）
      results.push({ provider, items: [], total: 0, error: message });
    }
  });
  await Promise.all(tasks);
  return results;
}

export interface StockDownloadInput {
  url: string;
  provider: StockProvider;
  /** 缺省时按 URL 后缀推断，再缺省按图片处理 */
  mediaType?: StockMediaType;
  category?: DbAssetCategory;
  name?: string;
  description?: string;
  author?: string;
  license?: string;
  duration?: number;
}

/** 从 URL 路径推断文件后缀（去掉 query string），推断不出返回 undefined */
function extFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.(jpe?g|png|webp|gif|mp4|mov|webm)$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Download a stock asset by URL and import it into the local asset library
 * with proper license/compliance metadata. 支持图片和视频。
 */
export async function downloadStockAsset(input: StockDownloadInput) {
  const category = input.category ?? "scenes";
  const licenseMap: Record<string, "cc0" | "commercial"> = {
    openverse: "cc0",
    pexels: "commercial",
    pixabay: "cc0",
    unsplash: "commercial",
  };
  const urlExt = extFromUrl(input.url);
  const videoExts = ["mp4", "mov", "webm"];
  const mediaType: StockMediaType = input.mediaType
    ?? (urlExt && videoExts.includes(urlExt) ? "video" : "image");
  const ext = urlExt ?? (mediaType === "video" ? "mp4" : "jpg");
  const asset = await uploadAsset({
    name: input.name ?? `stock_${input.provider}_${Date.now()}.${ext}`,
    data: Buffer.from(await (await fetch(input.url)).arrayBuffer()),
    category,
    type: mediaType,
    source: input.provider as "pexels" | "pixabay" | "unsplash",
    license: licenseMap[input.provider],
    tags: [input.provider, mediaType],
    metadata: {
      author: input.author,
      description: input.description,
      sourceUrl: input.url,
      license: input.license,
      mediaType,
      duration: input.duration,
    },
  });
  return asset;
}

/** Returns which stock providers are configured (Openverse is always available). */
export async function getConfiguredStockProviders(): Promise<StockProvider[]> {
  const config = await loadConfig();
  const out: StockProvider[] = ["openverse"]; // always available, no key
  if (config.pexels?.apiKey) out.push("pexels");
  if (config.pixabay?.apiKey) out.push("pixabay");
  if (config.unsplash?.accessKey) out.push("unsplash");
  return out;
}