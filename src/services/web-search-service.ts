/**
 * 通用联网搜索/抓取服务(2026-09-03)。
 * 背景:此前全网检索只有 Kimi 服务端内置 $web_search 一条腿,research/plan 档
 * 配 deepseek/glm 时完全无联网能力,调研幻觉率居高不下(实测两次评审 fail 均因
 * 虚构政策文号)。本服务把搜索做成 provider 无关的客户端能力:
 *   - webSearch: Bing RSS 免费接口(2026-09-16 F1 起;更早为 HTML 抓取,已废弃)
 *   - webFetch: 直接抓取网页并提取正文(无外部依赖)
 *   - platformSearch: 平台站内搜索(yt-dlp bilisearch/ytsearch + 知乎官方 API
 *     + 抖音/小红书 Playwright 登录态 scraper)
 * 检索留痕:所有 webSearch/platformSearch 结果落盘 dataDir/logs/search-log.jsonl(供评审复核)。
 * 预留扩展:配置 search.tavilyKey / search.bochaKey 后可加 Tavily/博查后端。
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { zhihuSearch } from "./zhihu-data-api.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 20_000;
const YTDLP_TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 1_500_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 信源等级(见 sourceTier):官方/机构/媒体/厂商/未核验。 */
  tier?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&ensp;|&emsp;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0183;|&middot;/g, "·");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""));
}

/** SSRF 防护(2026-09-16 S2;X19 加固 2026-09-07):拦截回环/内网/元数据地址。 */
const SSRF_BLOCKED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254.169.254"];
/** 内网网段正则:10.x / 192.168.x / 172.16~31.x */
const SSRF_PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
/** IPv6 链路本地(fe80::/10)与 ULA(fc00::/7)前缀(X19:此前只拦 IPv4 网段) */
const SSRF_PRIVATE6_RE = /^(fe80|fe90|fea0|feb0|fc|fd)/i;

function assertSafeUrl(rawUrl: string): void {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new Error("非法 URL");
  }
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase(); // 去除 IPv6 方括号
  if (SSRF_BLOCKED_HOSTS.includes(normalized)) throw new Error("SSRF 拦截:禁止访问回环/内网/元数据地址");
  if (SSRF_PRIVATE_RE.test(normalized)) throw new Error("SSRF 拦截:禁止访问内网网段");
  if (SSRF_PRIVATE6_RE.test(normalized)) throw new Error("SSRF 拦截:禁止访问 IPv6 链路本地/ULA 网段");
  // X19:域名以 IP 字面量的十进制/十六进制变种绕过(如 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(normalized) || /^0x/i.test(normalized)) throw new Error("SSRF 拦截:禁止 IP 数字字面量");
}

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // X19 验收修复(2026-09-07):redirect:"follow" 时重定向目标不再过 assertSafeUrl——
    // 公网 URL 302 到 169.254.169.254 即可穿透黑名单。改为 manual 逐跳校验(最多 5 跳)。
    let current = url;
    let res: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      assertSafeUrl(current);
      res = await fetch(current, {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: ctrl.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`HTTP ${res.status}(无 Location)`);
        current = new URL(loc, current).toString(); // 相对重定向解析为绝对,下跳开头重新校验
        continue;
      }
      break;
    }
    if (!res) throw new Error("请求失败");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= MAX_HTML_BYTES) break;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(
      chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c))),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Bing RSS 解析(2026-09-16 F1):手写 <item> 正则,零新依赖。 */
function parseBingRss(xml: string): SearchResult[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const out: SearchResult[] = [];
  for (const block of items) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const url = block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "";
    const snippet = block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
    if (!title && !url) continue;
    out.push({
      title: stripTags(title).trim(),
      url: url.trim(),
      snippet: stripTags(snippet).replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

/**
 * 信源分级(F2):按域名白名单对 URL 打信源等级。
 * 匹配采用"最长后缀优先",避免 stats.gov.cn 被更泛的 gov.cn 抢占为 official。
 */
const TIER_DOMAINS: Array<{ tier: string; domain: string }> = [
  { tier: "official", domain: "gov.cn" },
  { tier: "institutional", domain: "stats.gov.cn" },
  { tier: "institutional", domain: "npc.gov.cn" },
  { tier: "media", domain: "people.com.cn" },
  { tier: "media", domain: "xinhuanet.com" },
  { tier: "media", domain: "cnr.cn" },
  // vendor(厂商披露/白皮书,X16 验收修复:此前该级无域名配置,永不产出)
  { tier: "vendor", domain: "alibabacloud.com" },
  { tier: "vendor", domain: "tencent.com" },
  { tier: "vendor", domain: "cloud.tencent.com" },
  { tier: "vendor", domain: "huawei.com" },
  { tier: "vendor", domain: "baidu.com" },
  { tier: "vendor", domain: "bytedance.com" },
  { tier: "vendor", domain: "volcengine.com" },
  { tier: "vendor", domain: "minimaxi.com" },
];

/** 检索留痕(F1/F6 验收修复,2026-09-07):所有检索结果落盘 JSONL,供评审复核与失败率统计。 */
async function appendSearchLog(source: "web" | "platform", query: string, platform: string, results: SearchResult[]): Promise<void> {
  try {
    const dir = join(dataDir, "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, "search-log.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        source,
        platform,
        query,
        count: results.length,
        results: results.map((r) => ({ title: r.title, url: r.url, tier: r.tier })),
      }) + "\n",
      "utf-8",
    );
  } catch { /* 落盘失败不阻断检索 */ }
}

export function sourceTier(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unverified";
  }
  let best: { tier: string; domain: string } | undefined;
  for (const entry of TIER_DOMAINS) {
    if (host === entry.domain || host.endsWith("." + entry.domain)) {
      if (!best || entry.domain.length > best.domain.length) best = entry;
    }
  }
  return best ? best.tier : "unverified";
}

/** 权威源白名单(F5):检索路由优先前置。与 sourceTier 共用"最长后缀"匹配。 */
const AUTHORITATIVE_DOMAINS = ["gov.cn", "stats.gov.cn", "npc.gov.cn", "mohurd.gov.cn", "henan.gov.cn"];

function isAuthoritativeDomain(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AUTHORITATIVE_DOMAINS.some(
    (d) => host === d || host.endsWith("." + d),
  );
}

/** 排序:权威域名结果前置(稳定,保持原相对次序)。 */
function sortAuthoritativeFirst(results: SearchResult[]): SearchResult[] {
  return results.map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const aAuth = isAuthoritativeDomain(a.r.url) ? 0 : 1;
      const bAuth = isAuthoritativeDomain(b.r.url) ? 0 : 1;
      if (aAuth !== bAuth) return aAuth - bAuth;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/**
 * Bing RSS 搜索(F1,免 key,host 双备份自动切换)。返回结果带 tier 字段,
 * 且权威域名结果前置。无结果时返回空数组。
 */
export async function webSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  const n = Math.min(Math.max(1, maxResults), 10);
  for (const host of ["cn.bing.com", "www.bing.com"]) {
    const url = `https://${host}/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-CN`;
    try {
      const items = parseBingRss(await fetchText(url)).slice(0, n);
      if (items.length) {
        const results = sortAuthoritativeFirst(items.map((r) => ({ ...r, tier: sourceTier(r.url) })));
        // F5(2026-09):检索结果沉淀到 data_sources（同主题二次调研复用；fire-and-forget 不阻塞检索）
        void import("../db/data-sources-repo.js").then((m) => {
          for (const r of results.slice(0, 5)) {
            try {
              m.recordDataSourceReference({ url: r.url, title: r.title, tier: r.tier });
            } catch { /* 单条沉淀失败不影响检索 */ }
          }
        }).catch(() => {});
        void appendSearchLog("web", query, "bing-rss", results);
        return results;
      }
    } catch {
      // 当前 host 失败,切换到备份 host
    }
  }
  return [];
}

/** 抓取网页并提取正文文本(去脚本/样式/标签,折叠空白)。 */
export async function webFetch(targetUrl: string, maxChars = 6000): Promise<string> {
  const cap = Math.min(Math.max(500, maxChars), 20000);
  const raw = await fetchText(targetUrl);
  const contentTypeHint = raw.slice(0, 200).toLowerCase();
  if (!contentTypeHint.includes("<html") && !contentTypeHint.includes("<!doctype")) {
    // 非 HTML(JSON/纯文本等):直接截断返回
    return raw.slice(0, cap);
  }
  const cleaned = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = stripTags(cleaned)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";
  const body = text.length > cap ? text.slice(0, cap) + `\n…(已截断,全文约 ${text.length} 字)` : text;
  return (title ? `【页面标题】${title}\n\n` : "") + body;
}

/** yt-dlp 搜索前缀映射:平台 → yt-dlp 搜索表达式 */
const YTDLP_SEARCH_PREFIX: Record<string, string> = {
  bilibili: "bilisearch",
  youtube: "ytsearch",
};

/** 平台站内搜索。返回视频/笔记/问答链接清单,结果带 tier 并落盘 search-log.jsonl。 */
export async function platformSearch(platform: string, query: string, limit = 5): Promise<SearchResult[]> {
  const n = Math.min(Math.max(1, limit), 10);
  const key = platform.toLowerCase();
  // F6:知乎并入 L3——官方 API(zhihuSearch,免费 5000/天),与 yt-dlp 后端并列
  if (key === "zhihu") {
    const results = (await zhihuSearch(query, n)).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.excerpt ?? "",
      tier: sourceTier(r.url ?? ""),
    }));
    void appendSearchLog("platform", query, key, results);
    return results;
  }
  // F6 验收修复(2026-09-07):抖音/小红书走 Playwright 登录态 scraper 的 search()
  // (此前两个 search 方法建好但 platformSearch 未路由,属死代码)。复用发布画像的
  // persistent context,scraper 内部已带 ≥2s 防风控间隔。
  if (key === "douyin") {
    const { DouyinScraper } = await import("./platform-adapters/douyin-scraper.js");
    const results = await new DouyinScraper().search(query, n);
    void appendSearchLog("platform", query, key, results);
    return results;
  }
  if (key === "xiaohongshu" || key === "xhs") {
    const { XiaohongshuScraper } = await import("./platform-adapters/xiaohongshu-scraper.js");
    const results = await new XiaohongshuScraper().search(query, n);
    void appendSearchLog("platform", query, "xiaohongshu", results);
    return results;
  }
  const prefix = YTDLP_SEARCH_PREFIX[key];
  if (!prefix) {
    throw new Error(
      `暂不支持的平台 "${platform}"。当前支持:${Object.keys(YTDLP_SEARCH_PREFIX).join("/")}/zhihu/douyin/xiaohongshu。`,
    );
  }
  const expr = `${prefix}${n}:${query}`;
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const proc = spawn("yt-dlp", [expr, "--flat-playlist", "--dump-single-json", "--no-warnings"], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`yt-dlp 搜索超时(${YTDLP_TIMEOUT_MS / 1000}s)`));
    }, YTDLP_TIMEOUT_MS);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp 启动失败:${e.message}(确认 yt-dlp 在 PATH 中)`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolvePromise(out);
      else reject(new Error(`yt-dlp 退出码 ${code}:${err.slice(0, 300)}`));
    });
  });
  const data = JSON.parse(stdout) as { entries?: Array<{ id?: string; url?: string; title?: string }> };
  const results = (data.entries ?? []).slice(0, n).map((e) => ({
    title: e.title ?? "",
    url: e.url ?? "",
    snippet: e.title ? "" : `(条目 ID ${e.id ?? "?"},用 WebFetch 抓页面可见标题/详情)`,
    tier: sourceTier(e.url ?? ""),
  }));
  void appendSearchLog("platform", query, key, results);
  return results;
}
