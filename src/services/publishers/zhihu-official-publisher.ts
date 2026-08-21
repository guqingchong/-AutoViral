import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { resolveAccountCredential } from "../credential-resolver.js";

const BASE = "https://api.zhihu.com";

interface ZhihuArticleResponse {
  id?: string;
  url?: string;
  error?: { message?: string };
}

/**
 * Zhihu publisher using the official OAuth API.
 *
 * Zhihu's open API supports article (文章) creation via POST /articles.
 * Video publishing is not available through the public API, so this publisher
 * creates a Zhihu article from the work's content (the PRD lists 知乎 as 文章/视频).
 *
 * Credential: access_token (Zhihu OAuth bearer token, key "access_token").
 */
export class ZhihuOfficialPublisher implements Publisher {
  readonly platform = "zhihu";
  readonly name = "知乎";

  isConfigured(accountId?: string): boolean {
    return !!resolveAccountCredential(this.platform, accountId, "access_token");
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const accessToken = resolveAccountCredential(this.platform, input.accountId, "access_token");
    if (!accessToken) {
      return { success: false, error: "缺少知乎 access_token" };
    }

    try {
      const content =
        (input.options?.content as string) ??
        (input.options?.description as string) ??
        input.title;

      const res = await fetch(`${BASE}/articles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: input.title, content }),
      });
      const data = (await res.json()) as ZhihuArticleResponse;
      if (!data.id) {
        return { success: false, error: `知乎发布失败：${data.error?.message ?? JSON.stringify(data)}` };
      }
      return {
        success: true,
        platformPostId: String(data.id),
        postUrl: data.url ?? `https://zhuanlan.zhihu.com/p/${data.id}`,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}