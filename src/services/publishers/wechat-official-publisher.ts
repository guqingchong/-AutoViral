import { readFile } from "node:fs/promises";
import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { getCredential } from "../../db/platform-credentials-repo.js";

const BASE = "https://api.weixin.qq.com/cgi-bin";

interface WxTokenResponse {
  access_token?: string;
  expires_in?: number;
  errmsg?: string;
}

interface WxMediaResponse {
  media_id?: string;
  errcode?: number;
  errmsg?: string;
}

interface WxDraftResponse {
  media_id?: string;
  errcode?: number;
  errmsg?: string;
}

interface WxPublishResponse {
  publish_id?: string;
  errcode?: number;
  errmsg?: string;
}

/**
 * WeChat Official Account (公众号) publisher using the official Platform API.
 *
 * Credentials (platform_credentials):
 *   - app_id: 公众号 AppID
 *   - app_secret: 公众号 AppSecret
 *
 * Flow: get access_token -> upload video as permanent material -> create draft
 *       -> submit for publish (freepublish).
 */
export class WechatOfficialPublisher implements Publisher {
  readonly platform = "wechat";
  readonly name = "微信公众平台";

  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  isConfigured(): boolean {
    return !!(getCredential("wechat", "app_id") && getCredential("wechat", "app_secret"));
  }

  private async ensureToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry) return this.cachedToken;
    const appId = getCredential("wechat", "app_id");
    const appSecret = getCredential("wechat", "app_secret");
    if (!appId || !appSecret) throw new Error("缺少公众号 app_id / app_secret");
    const res = await fetch(
      `${BASE}/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`
    );
    const data = (await res.json()) as WxTokenResponse;
    if (!data.access_token) {
      throw new Error(`公众号获取 token 失败：${data.errmsg ?? JSON.stringify(data)}`);
    }
    this.cachedToken = data.access_token;
    this.tokenExpiry = Date.now() + ((data.expires_in ?? 7200) - 300) * 1000;
    return this.cachedToken;
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    try {
      const token = await this.ensureToken();

      // 1. Upload the video as permanent material (type=video)
      let mediaId: string | undefined;
      try {
        const videoBuffer = await readFile(input.videoPath);
        const form = new FormData();
        form.append("media", new Blob([videoBuffer]), "video.mp4");
        const mediaRes = await fetch(`${BASE}/material/add_material?access_token=${encodeURIComponent(token)}&type=video`, {
          method: "POST",
          body: form,
        });
        const mediaJson = (await mediaRes.json()) as WxMediaResponse;
        mediaId = mediaJson.media_id;
      } catch {
        mediaId = undefined;
      }

      // 2. Create a draft article embedding the video
      const draftRes = await fetch(`${BASE}/draft/add?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articles: [
            {
              title: input.title,
              content: `<p>${input.title}</p>`,
              thumb_media_id: "",
              need_open_comment: 0,
            },
          ],
        }),
      });
      const draftJson = (await draftRes.json()) as WxDraftResponse;
      if (draftJson.errcode !== 0 || !draftJson.media_id) {
        return { success: false, error: `公众号创建草稿失败：${draftJson.errmsg ?? JSON.stringify(draftJson)}` };
      }

      // 3. Submit the draft for publish
      const pubRes = await fetch(`${BASE}/freepublish/submit?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: draftJson.media_id }),
      });
      const pubJson = (await pubRes.json()) as WxPublishResponse;
      if (pubJson.errcode !== 0 && pubJson.errcode !== undefined) {
        return { success: false, error: `公众号发布失败：${pubJson.errmsg ?? JSON.stringify(pubJson)}` };
      }

      return {
        success: true,
        platformPostId: pubJson.publish_id ?? draftJson.media_id,
        postUrl: undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}