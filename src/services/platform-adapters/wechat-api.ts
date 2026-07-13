/**
 * WeChat (微信公众号) platform adapter.
 *
 * Uses WeChat Official Account API with access_token.
 * Configuration: WECHAT_APP_ID / WECHAT_APP_SECRET (env).
 *
 * Note: WeChat Official Accounts have limited analytics for individual articles.
 * This adapter captures what is available through the open API.
 */

import type { CollectedComment, CollectedMetrics, PlatformAdapter, ReplyResult } from "./types.js";
import { apiGet, apiPost } from "./fetch-helper.js";

const BASE = "https://api.weixin.qq.com";

export class WechatAdapter implements PlatformAdapter {
  readonly platform = "wechat";
  readonly label = "微信公众号";

  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private appId: string = process.env["WECHAT_APP_ID"] ?? "",
    private appSecret: string = process.env["WECHAT_APP_SECRET"] ?? ""
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    const data = (await apiGet(
      `${BASE}/cgi-bin/token?grant_type=client_credential&appid=${this.appId}&secret=${this.appSecret}`
    )) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return this.accessToken!;
  }

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    await this.ensureToken();
    // WeChat user summary API
    const data = (await apiPost(
      `${BASE}/cgi-bin/user/info/batchget?access_token=${this.accessToken}`,
      { user_list: [] }
    ).catch(() => ({ total: 0 }))) as { total?: number };
    return {
      followers: data.total ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: data as Record<string, unknown>,
    };
  }

  async collectPostMetrics(externalId: string): Promise<CollectedMetrics> {
    await this.ensureToken();
    // WeChat article total statistics via datacube
    const data = (await apiPost(
      `${BASE}/datacube/getarticletotal?access_token=${this.accessToken}`,
      { begin_date: daysAgo(7), end_date: daysAgo(1) }
    )) as { list?: Array<{ msgid?: string; int_page_read_count?: number; share_count?: number; add_to_fav_count?: number }> };
    const match = data.list?.find(
      (d) => d.msgid === externalId
    );
    return {
      views: match?.int_page_read_count ?? 0,
      shares: match?.share_count ?? 0,
      collects: match?.add_to_fav_count ?? 0,
      collectedAt: new Date().toISOString(),
      rawData: (match ?? {}) as Record<string, unknown>,
    };
  }

  async collectComments(
    externalId: string,
    _cursor?: string
  ): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    await this.ensureToken();
    // WeChat comment list — only available for articles with open comments
    const data = (await apiPost(
      `${BASE}/cgi-bin/comment/list?access_token=${this.accessToken}`,
      { msg_data_id: externalId, index: 0, count: 50, type: 0 }
    )) as { comment?: Array<{ user_comment_id: string; nick_name: string; openid: string; content: string }>; total?: number };
    const list = data.comment ?? [];
    return {
      comments: list.map((c) => ({
        externalCommentId: c.user_comment_id,
        authorName: c.nick_name,
        authorId: c.openid,
        content: c.content,
        isReply: false,
        collectedAt: new Date().toISOString(),
      })),
      nextCursor: undefined, // WeChat doesn't paginate comments the same way
    };
  }

  async publishReply(externalCommentId: string, text: string): Promise<ReplyResult> {
    try {
      await this.ensureToken();
      const res = (await apiPost(
        `${BASE}/cgi-bin/comment/reply/add?access_token=${this.accessToken}`,
        { msg_data_id: externalCommentId, content: text }
      )) as { errcode?: number; errmsg?: string };
      if (res.errcode === 0) return { success: true };
      return { success: false, error: res.errmsg ?? `errcode=${res.errcode}` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
