/**
 * Douyin (抖音) platform scraper using Playwright.
 *
 * Since Douyin has no public API for creator analytics, this scrapes
 * the Creator Portal (creator.douyin.com) with a persistent browser session.
 * The user must log in once manually; subsequent runs reuse cookies.
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { getContext, saveState } from "./playwright-helper.js";

export class DouyinScraper implements PlatformAdapter {
  readonly platform = "douyin";
  readonly label = "抖音";
  /** 浏览器 context 键:`douyin:<accountId ?? "default">`,画像目录按账号隔离 */
  readonly contextKey: string;

  constructor(readonly accountId?: string) {
    this.contextKey = `douyin:${accountId ?? "default"}`;
  }

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      await page.goto("https://creator.douyin.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Extract follower count from the page
      const followers = await page
        .$eval('[data-e2e="follower-count"]', (el) => {
          const raw = el.textContent ?? "0";
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
      await page.goto(`https://creator.douyin.com/content/video/${externalId}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      // Wait for metrics to render
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
          views: getNum('[data-e2e="play-count"]'),
          likes: getNum('[data-e2e="like-count"]'),
          comments: getNum('[data-e2e="comment-count"]'),
          shares: getNum('[data-e2e="share-count"]'),
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
        `https://creator.douyin.com/content/comment/list?video_id=${externalId}&page=${pageNum}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 }
      );
      await page.waitForTimeout(2_000);

      const result = await page.evaluate(() => {
        const items = document.querySelectorAll('[data-e2e="comment-item"]');
        const comments: Array<{
          authorName: string;
          authorId: string;
          content: string;
        }> = [];
        items.forEach((el) => {
          const name = el.querySelector('[data-e2e="comment-author"]')?.textContent ?? "";
          const content = el.querySelector('[data-e2e="comment-text"]')?.textContent ?? "";
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
   * 抖音站内搜索（2026-09 F6）。复用同一 persistent context（browser-profiles
   * 同一画像，不重导 cookie），打开搜索结果页抓视频列表。
   * 【待实测校准】DOM 选择器为初版，页面结构变化可能失效。
   * 防风控：每条结果间延迟 ≥2s + 抖动。
   */
  async search(query: string, limit = 5): Promise<{ title: string; url: string; snippet: string }[]> {
    const ctx = await getContext(this.contextKey);
    const page = await ctx.newPage();
    try {
      await page.goto(`https://www.douyin.com/search/${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // 【待实测校准】等待视频列表渲染；选择器基于常见视频卡 a[href*="/video/"]
      await page.waitForSelector('a[href*="/video/"]', { timeout: 15_000 }).catch(() => {});
      const items = await page.$$eval(
        'a[href*="/video/"]',
        (els) =>
          els.slice(0, limit).map((e) => ({
            title: (e.querySelector("[title]")?.getAttribute("title") ?? e.textContent ?? "").trim(),
            url: e.getAttribute("href") ?? "",
            snippet: "",
          })),
      );
      // 防风控：每条间延迟 2s+ 抖动
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      for (const it of items) {
        results.push({ ...it, url: it.url.startsWith("http") ? it.url : `https://www.douyin.com${it.url}` });
        await page.waitForTimeout(2_000 + Math.floor(Math.random() * 1_500));
      }
      return results;
    } finally {
      await page.close();
    }
  }

  async publishReply(_externalCommentId: string, _text: string): Promise<ReplyResult> {
    // Douyin Creator Portal doesn't expose comment reply via scraping easily.
    // Replies must be done manually or through the mobile API (out of scope).
    return { success: false, error: "Douyin reply not supported via scraping" };
  }
}
