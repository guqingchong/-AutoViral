import { readFile } from "node:fs/promises";
import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { resolveAccountCredential } from "../credential-resolver.js";

const BASE = "https://open.kuaishou.com";

interface KsTokenResponse {
  access_token?: string;
  expires_in?: number;
  description?: string;
  result?: number;
}

interface KsUploadResponse {
  data?: { video?: { video_id?: string } };
  result?: number;
  description?: string;
}

interface KsPublishResponse {
  data?: { open_id?: string };
  result?: number;
  description?: string;
}

export class KuaishouOfficialPublisher implements Publisher {
  readonly platform = "kuaishou";
  readonly name = "快手开放平台";

  private cachedToken: string | null = null;
  private tokenExpiry = 0;
  private cachedAccountId: string | undefined;

  isConfigured(accountId?: string): boolean {
    return !!(
      resolveAccountCredential(this.platform, accountId, "app_id") &&
      resolveAccountCredential(this.platform, accountId, "app_secret")
    );
  }

  private async ensureToken(accountId?: string): Promise<string> {
    if (this.cachedToken && this.cachedAccountId === accountId && Date.now() < this.tokenExpiry) {
      return this.cachedToken;
    }
    const appId = resolveAccountCredential(this.platform, accountId, "app_id");
    const appSecret = resolveAccountCredential(this.platform, accountId, "app_secret");
    if (!appId || !appSecret) throw new Error("缺少快手 app_id / app_secret");
    const res = await fetch(`${BASE}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret, grant_type: "client_credentials" }),
    });
    const data = (await res.json()) as KsTokenResponse;
    if (!data.access_token) {
      throw new Error(`快手获取 token 失败：${data.description ?? JSON.stringify(data)}`);
    }
    this.cachedToken = data.access_token;
    this.tokenExpiry = Date.now() + ((data.expires_in ?? 7200) - 300) * 1000;
    this.cachedAccountId = accountId;
    return this.cachedToken;
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    try {
      const token = await this.ensureToken(input.accountId);

      const videoBuffer = await readFile(input.videoPath);
      const form = new FormData();
      form.append("video", new Blob([videoBuffer]), "video.mp4");

      const uploadRes = await fetch(
        `${BASE}/openapi/video/upload?access_token=${encodeURIComponent(token)}`,
        { method: "POST", body: form }
      );
      const uploadJson = (await uploadRes.json()) as KsUploadResponse;
      const videoId = uploadJson.data?.video?.video_id;
      if (!videoId) {
        return { success: false, error: `快手上传失败：${uploadJson.description ?? JSON.stringify(uploadJson)}` };
      }

      const publishRes = await fetch(
        `${BASE}/openapi/video/publish?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_id: videoId, title: input.title, cover: input.coverPath ?? "" }),
        }
      );
      const pubJson = (await publishRes.json()) as KsPublishResponse;
      const itemId = pubJson.data?.open_id;
      const ok = pubJson.result === 1 || !!itemId;
      if (!ok) {
        return { success: false, error: `快手发布失败：${pubJson.description ?? JSON.stringify(pubJson)}` };
      }
      return {
        success: true,
        platformPostId: itemId,
        postUrl: itemId ? `https://www.kuaishou.com/short-video/${itemId}` : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}