/**
 * Zhihu (知乎) platform adapter.
 *
 * Uses Zhihu OAuth 2.0. Configuration: ZHIHU_CLIENT_ID / ZHIHU_CLIENT_SECRET (env).
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { apiGet, apiPost } from "./fetch-helper.js";

const BASE = "https://api.zhihu.com";

export class ZhihuAdapter implements PlatformAdapter {
  readonly platform = "zhihu";
  readonly label = "知乎";

  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private clientId: string = process.env["ZHIHU_CLIENT_ID"] ?? "",
    private clientSecret: string = process.env["ZHIHU_CLIENT_SECRET"] ?? ""
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const data = (await apiPost(`${BASE}/oauth/token`, {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
    })) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return this.accessToken!;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    await this.ensureToken();
    const data = (await apiGet(`${BASE}/people/self`, {
      headers: this.authHeaders(),
    })) as { follower_count?: number };
    return {
      followers: data.follower_count ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectPostMetrics(externalId: string): Promise<CollectedMetrics> {
    await this.ensureToken();
    const data = (await apiGet(`${BASE}/answers/${externalId}`, {
      headers: this.authHeaders(),
    })) as { voteup_count?: number; comment_count?: number };
    return {
      views: undefined, // Zhihu doesn't expose view count via API
      likes: data.voteup_count ?? 0,
      comments: data.comment_count ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectComments(
    externalId: string,
    cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    await this.ensureToken();
    const params = new URLSearchParams({ answer_id: externalId, limit: "50" });
    if (cursor) params.set("offset", cursor);
    const data = (await apiGet(`${BASE}/comments?${params}`, {
      headers: this.authHeaders(),
    })) as { data?: Array<{ id: string; author?: { name?: string; id?: string }; content: string; in_reply_to?: string }>; paging?: { next?: string } };
    const list = data.data ?? [];
    return {
      comments: list.map((c) => ({
        externalCommentId: c.id,
        authorName: c.author?.name ?? "",
        authorId: c.author?.id ?? undefined,
        content: c.content,
        isReply: !!c.in_reply_to,
        parentExternalId: c.in_reply_to ?? undefined,
        collectedAt: new Date().toISOString(),
      })),
      nextCursor: data.paging?.next ?? undefined,
    };
  }

  async publishReply(externalCommentId: string, text: string): Promise<ReplyResult> {
    try {
      await this.ensureToken();
      await apiPost(`${BASE}/comments/${externalCommentId}/replies`, {
        content: text,
      }, { headers: this.authHeaders() });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
