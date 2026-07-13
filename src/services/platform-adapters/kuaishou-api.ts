/**
 * Kuaishou (快手) platform adapter using the official Kuaishou Open API.
 *
 * Configuration required:
 *   - KUASHOU_APP_ID / KUASHOU_APP_SECRET (env)
 *   - Access token refreshed via OAuth 2.0 client_credentials.
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { apiGet, apiPost } from "./fetch-helper.js";

const BASE = "https://open.kuaishou.com";

export class KuaishouAdapter implements PlatformAdapter {
  readonly platform = "kuaishou";
  readonly label = "快手";

  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private appId: string = process.env["KUASHOU_APP_ID"] ?? "",
    private appSecret: string = process.env["KUASHOU_APP_SECRET"] ?? ""
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const data = (await apiPost(`${BASE}/oauth2/access_token`, {
      app_id: this.appId,
      app_secret: this.appSecret,
      grant_type: "client_credentials",
    })) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return this.accessToken!;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    await this.ensureToken();
    const data = (await apiGet(`${BASE}/openapi/user/info`, {
      headers: this.authHeaders(),
    })) as { result?: { follower_count?: number; video_count?: number } };
    const r = data.result ?? {};
    return {
      followers: r.follower_count ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectPostMetrics(externalId: string): Promise<CollectedMetrics> {
    await this.ensureToken();
    const data = (await apiGet(`${BASE}/openapi/video/info?video_id=${externalId}`, {
      headers: this.authHeaders(),
    })) as { result?: { play_count?: number; like_count?: number; comment_count?: number; share_count?: number } };
    const r = data.result ?? {};
    return {
      views: r.play_count ?? 0,
      likes: r.like_count ?? 0,
      comments: r.comment_count ?? 0,
      shares: r.share_count ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectComments(
    externalId: string,
    cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    await this.ensureToken();
    const params = new URLSearchParams({ video_id: externalId, count: "50" });
    if (cursor) params.set("cursor", cursor);
    const data = (await apiGet(`${BASE}/openapi/comment/list?${params}`, {
      headers: this.authHeaders(),
    })) as { result?: { comments?: Array<{ comment_id: string; user_name: string; user_id: string; content: string; reply_to?: string }>; next_cursor?: string } };
    const list = data.result?.comments ?? [];
    return {
      comments: list.map((c) => ({
        externalCommentId: c.comment_id,
        authorName: c.user_name,
        authorId: c.user_id,
        content: c.content,
        isReply: !!c.reply_to,
        parentExternalId: c.reply_to ?? undefined,
        collectedAt: new Date().toISOString(),
      })),
      nextCursor: data.result?.next_cursor ?? undefined,
    };
  }

  async publishReply(externalCommentId: string, text: string): Promise<ReplyResult> {
    try {
      await this.ensureToken();
      await apiPost(`${BASE}/openapi/comment/reply`, {
        comment_id: externalCommentId,
        content: text,
      }, { headers: this.authHeaders() });
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
