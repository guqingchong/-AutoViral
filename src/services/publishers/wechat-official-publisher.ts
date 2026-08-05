import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

interface WxUploadImgResponse {
  url?: string;
  errcode?: number;
  errmsg?: string;
}

/**
 * 计算正文插图位置：返回「在该段落（0 起索引）之后插图」的段落索引列表。
 * 约束：约每 2~3 个段落插一张；图片多于段落承载量时取前 N 张均匀分布。
 */
export function planImageInsertions(paragraphCount: number, imageCount: number): number[] {
  if (paragraphCount <= 0 || imageCount <= 0) return [];
  const maxUsable = Math.max(1, Math.floor(paragraphCount / 2));
  const n = Math.min(imageCount, maxUsable);
  const positions: number[] = [];
  for (let k = 1; k <= n; k++) {
    const idx = Math.min(paragraphCount - 1, Math.floor((k * paragraphCount) / (n + 1)));
    if (!positions.includes(idx)) positions.push(idx);
  }
  return positions;
}

/**
 * WeChat Official Account (公众号) publisher using the official Platform API.
 *
 * Credentials (platform_credentials):
 *   - app_id: 公众号 AppID
 *   - app_secret: 公众号 AppSecret
 *
 * Flow: get access_token -> upload cover image (thumb) -> create draft with
 *       article content -> submit for publish (freepublish).
 *       草稿正文取自 input.options.content（buildPublishInput 注入的文章内容），
 *       封面取自 input.coverPath（公众号草稿必须 thumb_media_id）。
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

  /** 纯文本切分为转义后的段落数组 */
  private splitParagraphs(raw: string): string[] {
    const escaped = raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped
      .split(/\n{2,}|\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  /** 纯文本/Markdown 转公众号 HTML（按段落换行包装 <p>，转义 HTML 特殊字符） */
  private toHtml(raw: string): string {
    return this.splitParagraphs(raw)
      .map((p) => `<p>${p}</p>`)
      .join("");
  }

  /** 段落间插入正文图片（imageUrls 为 uploadimg 返回的微信正文图 URL） */
  private toHtmlWithImages(raw: string, imageUrls: string[]): string {
    const paragraphs = this.splitParagraphs(raw);
    if (paragraphs.length === 0 || imageUrls.length === 0) return this.toHtml(raw);
    const positions = planImageInsertions(paragraphs.length, imageUrls.length);
    const parts: string[] = [];
    let imgIdx = 0;
    paragraphs.forEach((p, i) => {
      parts.push(`<p>${p}</p>`);
      if (positions.includes(i) && imgIdx < imageUrls.length) {
        parts.push(`<p><img src="${imageUrls[imgIdx]}" /></p>`);
        imgIdx++;
      }
    });
    return parts.join("");
  }

  /** 上传封面图作为永久图片素材，返回 thumb 用 media_id */
  private async uploadThumb(token: string, coverPath: string): Promise<string | undefined> {
    try {
      const imgBuffer = await readFile(coverPath);
      const form = new FormData();
      form.append("media", new Blob([imgBuffer]), "cover.jpg");
      const res = await fetch(`${BASE}/material/add_material?access_token=${encodeURIComponent(token)}&type=image`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as WxMediaResponse;
      return data.media_id;
    } catch {
      return undefined;
    }
  }

  /**
   * 上传正文图片（POST /cgi-bin/media/uploadimg）。
   * 返回的正文图 URL 可直接用于草稿 content，不占用素材库配额；
   * 失败返回 undefined（该图跳过，不中断发布）。
   */
  private async uploadContentImage(token: string, imagePath: string): Promise<string | undefined> {
    try {
      const imgBuffer = await readFile(imagePath);
      const form = new FormData();
      form.append("media", new Blob([imgBuffer]), basename(imagePath) || "image.jpg");
      const res = await fetch(`${BASE}/media/uploadimg?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as WxUploadImgResponse;
      return data.url;
    } catch {
      return undefined;
    }
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    try {
      const token = await this.ensureToken();

      // 1. 封面图（公众号草稿必填 thumb_media_id）
      let thumbMediaId: string | undefined;
      if (input.coverPath) {
        thumbMediaId = await this.uploadThumb(token, input.coverPath);
      }
      if (!thumbMediaId) {
        return {
          success: false,
          error: "公众号发布需要封面图：请确保作品 output/cover.jpg 存在（封面上传失败或缺失）",
        };
      }

      // 2. 草稿正文：优先文章内容（options.content），退回标题；
      //    options.contentImages 存在时逐张走 uploadimg 换正文图 URL，按段落插图
      const rawContent =
        (input.options?.content as string) ??
        (input.options?.description as string) ??
        input.title;
      const contentImages = Array.isArray(input.options?.contentImages)
        ? (input.options.contentImages as unknown[]).filter(
            (p): p is string => typeof p === "string" && p.length > 0
          )
        : [];
      let htmlContent: string;
      if (contentImages.length > 0) {
        const imageUrls: string[] = [];
        for (const imgPath of contentImages) {
          const url = await this.uploadContentImage(token, imgPath);
          if (url) imageUrls.push(url);
        }
        htmlContent =
          imageUrls.length > 0
            ? this.toHtmlWithImages(rawContent, imageUrls)
            : this.toHtml(rawContent);
      } else {
        htmlContent = this.toHtml(rawContent);
      }
      htmlContent = htmlContent || `<p>${input.title}</p>`;

      // 3. Create a draft article
      const draftRes = await fetch(`${BASE}/draft/add?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articles: [
            {
              title: input.title,
              content: htmlContent,
              thumb_media_id: thumbMediaId,
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