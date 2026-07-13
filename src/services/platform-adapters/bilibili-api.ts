/**
 * Bilibili (哔哩哔哩) platform adapter.
 *
 * Uses the Bilibili Open API with access_key authentication.
 * Configuration: BILIBILI_CLIENT_ID / BILIBILI_CLIENT_SECRET (env).
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { apiGet, apiPost } from "./fetch-helper.js";

const BASE = "https://api.bilibili.com";

export class BilibiliAdapter implements PlatformAdapter {
  readonly platform = "bilibili";
  readonly label = "哔哩哔哩";

  constructor(
    private clientId: string = process.env["BILIBILI_CLIENT_ID"] ?? "",
    private clientSecret: string = process.env["BILIBILI_CLIENT_SECRET"] ?? ""
  ) {}

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    // Bilibili account stats via /x/relation/stat
    const data = (await apiGet(`${BASE}/x/relation/stat?jsonp=jsonp`)) as {
      data?: { follower?: number };
    };
    return {
      followers: data.data?.follower ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectPostMetrics(externalId: string): Promise<CollectedMetrics> {
    const data = (await apiGet(
      `${BASE}/x/web-interface/view?aid=${externalId}`
    )) as { data?: { stat?: { view?: number; like?: number; reply?: number; share?: number; favorite?: number } } };
    const s = data.data?.stat ?? {};
    return {
      views: s.view ?? 0,
      likes: s.like ?? 0,
      comments: s.reply ?? 0,
      shares: s.share ?? 0,
      collects: s.favorite ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectComments(
    externalId: string,
    cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    const params = new URLSearchParams({ oid: externalId, type: "1", ps: "50" });
    if (cursor) params.set("pn", cursor);
    const data = (await apiGet(`${BASE}/x/v2/reply?${params}`)) as {
      data?: { replies?: Array<{ rpid: number; member?: { uname?: string; mid?: string }; content?: { message?: string }; parent?: number }>; page?: { count?: number; num?: number } };
    };
    const list = data.data?.replies ?? [];
    const pageNum = data.data?.page?.num ?? 1;
    const total = data.data?.page?.count ?? 0;
    const hasMore = pageNum * 50 < total;
    return {
      comments: list.map((c) => ({
        externalCommentId: String(c.rpid),
        authorName: c.member?.uname ?? "",
        authorId: c.member?.mid ? String(c.member.mid) : undefined,
        content: c.content?.message ?? "",
        isReply: !!c.parent,
        parentExternalId: c.parent ? String(c.parent) : undefined,
        collectedAt: new Date().toISOString(),
      })),
      nextCursor: hasMore ? String(pageNum + 1) : undefined,
    };
  }

  async publishReply(externalCommentId: string, text: string): Promise<ReplyResult> {
    try {
      const data = (await apiPost(`${BASE}/x/v2/reply/add`, {
        oid: externalCommentId,
        type: "1",
        message: text,
      })) as { code?: number; message?: string };
      if (data.code === 0) return { success: true };
      return { success: false, error: data.message ?? `code=${data.code}` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
