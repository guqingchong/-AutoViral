import { loadConfig } from "../config.js";

/**
 * 知乎数据开放平台（developer.zhihu.com）API 客户端。
 *
 * 用于选题调研与文章写作素材：
 * - fetchZhihuHotList：知乎热榜（选题调研数据源，比 newsnow 更权威）
 * - zhihuSearch：站内搜索（高质量问答素材）
 * - globalSearch：全网搜索（知乎+全网权威信源）
 *
 * 鉴权：Authorization: Bearer <Access Secret> + X-Request-Timestamp（秒级）。
 * Secret 在设置页「知乎数据平台 Access Secret」配置（个人中心免费 5000 次/天）。
 *
 * 注意：该 Secret 仅用于数据查询，与知乎发布（Playwright Cookie）互不相干。
 */

const BASE = "https://developer.zhihu.com/api/v1/content";
const TIMEOUT_MS = 15000;

export interface ZhihuHotItem {
  title: string;
  excerpt?: string;
  heat?: string;
  url?: string;
}

export interface ZhihuSearchResult {
  title: string;
  excerpt?: string;
  url?: string;
  author?: string;
  voteupCount?: number;
}

async function getSecret(): Promise<string | null> {
  const config = await loadConfig();
  const secret = config.zhihuData?.accessSecret?.trim();
  return secret || null;
}

async function callApi<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const secret = await getSecret();
  if (!secret) return null; // 未配置 Secret：降级，不中断调用方
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: {
      Authorization: `Bearer ${secret}`,
      "X-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`知乎数据平台 HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** 从响应中宽松提取条目数组（官方字段可能随版本微调） */
function extractItems(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  for (const key of ["data", "items", "list", "results", "Data"]) {
    const v = d[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object") {
      const inner = extractItems(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

/** 知乎热榜（默认 top 20） */
export async function fetchZhihuHotList(limit = 20): Promise<ZhihuHotItem[]> {
  const data = await callApi<unknown>("/hot_list", { Limit: String(limit) });
  return extractItems(data).map((it) => ({
    title: String(it.title ?? it.Title ?? it.question_title ?? ""),
    excerpt: String(it.excerpt ?? it.Excerpt ?? it.detail ?? ""),
    heat: String(it.heat ?? it.hot ?? it.hot_value ?? (it.metrics_area as Record<string, unknown> | undefined)?.text ?? ""),
    url: String(it.url ?? it.link ?? ""),
  })).filter((it) => it.title);
}

/** 知乎站内搜索 */
export async function zhihuSearch(query: string, count = 5): Promise<ZhihuSearchResult[]> {
  const data = await callApi<unknown>("/zhihu_search", { Query: query, Count: String(count) });
  return extractItems(data).slice(0, count).map((it) => ({
    title: String(it.title ?? it.Title ?? ""),
    excerpt: String(it.excerpt ?? it.Excerpt ?? it.content ?? "").slice(0, 300),
    url: String(it.url ?? it.link ?? ""),
    author: String(it.author ?? it.author_name ?? ""),
    voteupCount: Number(it.voteup_count ?? it.voteupCount ?? 0) || undefined,
  })).filter((it) => it.title || it.excerpt);
}

/** 全网搜索（知乎 + 全网权威信源） */
export async function globalSearch(query: string, count = 5): Promise<ZhihuSearchResult[]> {
  const data = await callApi<unknown>("/global_search", { Query: query, Count: String(count), SearchDB: "all" });
  return extractItems(data).slice(0, count).map((it) => ({
    title: String(it.title ?? it.Title ?? ""),
    excerpt: String(it.excerpt ?? it.Excerpt ?? it.content ?? "").slice(0, 300),
    url: String(it.url ?? it.link ?? ""),
    author: String(it.author ?? it.author_name ?? it.host ?? ""),
  })).filter((it) => it.title || it.excerpt);
}
