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

  constructor(readonly accountId?: string) {
    this.contextKey = `xiaohongshu:${accountId ?? "default"}`;
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
          externalCommentId: undefined,
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

  async publishReply(_externalCommentId: string, _text: string): Promise<ReplyResult> {
    // Xiaohongshu Creator Platform doesn't support programmatic reply via scraping.
    return { success: false, error: "Xiaohongshu reply not supported via scraping" };
  }
}
