/**
 * Xiaohongshu (小红书) platform scraper using Playwright.
 *
 * Xiaohongshu has no public creator API, so we scrape the Creator Platform
 * (creator.xiaohongshu.com) with a persistent browser session.
 * The user must log in once manually; subsequent runs reuse cookies.
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { getContext, saveState } from "./playwright-helper.js";

export class XiaohongshuScraper implements PlatformAdapter {
  readonly platform = "xiaohongshu";
  readonly label = "小红书";
  /** 浏览器 context 键:`xiaohongshu:<accountId ?? "default">`,画像目录按账号隔离 */
  readonly contextKey: string;

  constructor(readonly accountId?: string, contextKeyOverride?: string) {
    // C7(2026-09-08):搜索用独立画像(如 xiaohongshu:search),与发布画像物理分离
    this.contextKey = contextKeyOverride ?? `xiaohongshu:${accountId ?? "default"}`;
  }

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      await page.goto("https://creator.xiaohongshu.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Extract follower count from dashboard
      const followers = await page
        .evaluate(() => {
          const el = document.querySelector('[class*="follower"] [class*="count"]');
          if (!el?.textContent) return undefined;
          const raw = el.textContent;
          if (raw.includes("万")) return Math.round(parseFloat(raw) * 10_000);
          return parseInt(raw.replace(/[^0-9]/g, ""), 10) || 0;
        })
        .catch(() => undefined);

      return {
        followers,
        collectedAt: new Date().toISOString(),
        rawData: { source: "playwright" },
      };
    } finally {
      await page.close();
    }
  }

  async collectPostMetrics(externalId: string): Promise<CollectedMetrics> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      await page.goto(
        `https://creator.xiaohongshu.com/content/note/${externalId}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 }
      );
      await page.waitForTimeout(2_000);

      const metrics = await page.evaluate(() => {
        const getNum = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el?.textContent) return undefined;
          const raw = el.textContent;
          if (raw.includes("万")) return Math.round(parseFloat(raw) * 10_000);
          return parseInt(raw.replace(/[^0-9]/g, ""), 10) || 0;
        };
        return {
          views: getNum('[class*="view"] [class*="count"]'),
          likes: getNum('[class*="like"] [class*="count"]'),
          comments: getNum('[class*="comment"] [class*="count"]'),
          collects: getNum('[class*="collect"] [class*="count"]'),
        };
      });

      return {
        ...metrics,
        collectedAt: new Date().toISOString(),
        rawData: { source: "playwright" },
      };
    } finally {
      await page.close();
    }
  }

  async collectComments(
    externalId: string,
    cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      const pageNum = cursor ? parseInt(cursor, 10) : 1;
      await page.goto(
        `https://creator.xiaohongshu.com/content/comment/list?note_id=${externalId}&page=${pageNum}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 }
      );
      await page.waitForTimeout(2_000);

      const result = await page.evaluate(() => {
        const items = document.querySelectorAll('[class*="commentItem"]');
        const comments: Array<{
          authorName: string;
          authorId: string;
          content: string;
        }> = [];
        items.forEach((el) => {
          const name = el.querySelector('[class*="authorName"]')?.textContent ?? "";
          const content = el.querySelector('[class*="commentContent"]')?.textContent ?? "";
          comments.push({ authorName: name, authorId: "", content });
        });
        return { comments, hasMore: items.length >= 20 };
      });

      return {
        comments: result.comments.map((c) => ({
          // 批次7.7(A-1):DOM 无评论 ID——用 内容哈希合成稳定去重键(此前恒 undefined,去重永不命中+无限分页)
          externalCommentId: `${externalId}:${Buffer.from(`${c.authorName}:${c.content}`).toString("base64url").slice(0, 32)}`,
          authorName: c.authorName,
          authorId: c.authorId || undefined,
          content: c.content,
          isReply: false,
          collectedAt: new Date().toISOString(),
        })),
        nextCursor: result.hasMore ? String(pageNum + 1) : undefined,
      };
    } finally {
      await page.close();
      await saveState(this.contextKey);
    }
  }

  /**
   * 小红书站内搜索（2026-09 F6）。复用同一 persistent context（browser-profiles
   * 同一画像，不重导 cookie），打开搜索结果页抓笔记列表。
   * 【待实测校准】DOM 选择器为初版（section.note-item 内 a 标题/链接），页面结构变化可能失效。
   * 防风控：每条结果间延迟 ≥2s + 抖动。
   */
  async search(query: string, limit = 5): Promise<{ title: string; url: string; snippet: string }[]> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      // C7:防风控改为请求前一次性 2s 间隔(旧"逐条延迟"期间无任何请求,纯空转)
      await page.waitForTimeout(2_000);
      await page.goto(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // 【待实测校准】等待笔记区渲染；选择器基于 section.note-item 内 a 链接
      await page.waitForSelector("section.note-item a", { timeout: 15_000 }).catch(() => {});
      const items = await page.$$eval(
        "section.note-item a",
        (els) =>
          els
            .slice(0, limit)
            .map((e) => ({
              title: (e.querySelector(".title")?.textContent ?? e.textContent ?? "").trim(),
              url: e.getAttribute("href") ?? "",
              snippet: "",
            }))
            .filter((it) => it.url),
      );
      // C7:空结果显式报错(未登录/被风控可分辨),不静默返回空数组
      if (!items.length) {
        throw new Error(
          `小红书搜索无结果(画像 ${this.contextKey})——可能未登录或被风控。` +
          `重试无效,需人工检查 browser-profiles/${this.contextKey.replace(":", "/")} 登录态;agent 请改走 bilibili/zhihu 通道`,
        );
      }
      return items.map((it) => ({
        ...it,
        url: it.url.startsWith("http") ? it.url : `https://www.xiaohongshu.com${it.url}`,
      }));
    } finally {
      await page.close();
    }
  }

  async publishReply(_externalCommentId: string, _text: string): Promise<ReplyResult> {
    // Xiaohongshu Creator Platform doesn't support programmatic reply via scraping.
    return { success: false, error: "Xiaohongshu reply not supported via scraping" };
  }
}
