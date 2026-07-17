import { readFile } from "node:fs/promises";
import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { getCredential } from "../../db/platform-credentials-repo.js";

const MEMBER_BASE = "https://member.bilibili.com";

interface BiliPreUpload {
  end_point?: string;
  upos_uri?: string;
  auth?: string;
  biz_id?: number;
  error?: number;
  OK?: number;
}

interface BiliAddResponse {
  code?: number;
  message?: string;
  data?: { bvid?: string; aid?: number };
}

/**
 * Bilibili publisher using the member web upload + submit API.
 *
 * Credentials (stored in platform_credentials):
 *   - access_token: the member SESSDATA cookie value
 *   - csrf: the bili_jct cookie value
 *
 * Flow: pre-upload -> single-part upload -> submit (x/vu/web/add).
 */
export class BilibiliOfficialPublisher implements Publisher {
  readonly platform = "bilibili";
  readonly name = "哔哩哔哩";

  isConfigured(): boolean {
    return !!(getCredential("bilibili", "access_token") && getCredential("bilibili", "csrf"));
  }

  private cookieHeader(): string {
    const sess = getCredential("bilibili", "access_token") ?? "";
    const csrf = getCredential("bilibili", "csrf") ?? "";
    return `SESSDATA=${sess}; bili_jct=${csrf}`;
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const csrf = getCredential("bilibili", "csrf");
    if (!csrf) {
      return { success: false, error: "缺少哔哩哔哩 csrf (bili_jct)" };
    }

    try {
      const videoBuffer = await readFile(input.videoPath);

      const preRes = await fetch(`${MEMBER_BASE}/preupload?name=video.mp4&size=${videoBuffer.byteLength}`, {
        headers: { Cookie: this.cookieHeader() },
      });
      const pre = (await preRes.json()) as BiliPreUpload;
      if (pre.error !== undefined && pre.error !== 0) {
        return { success: false, error: `B站预上传失败：${JSON.stringify(pre)}` };
      }
      const uposUri = pre.upos_uri ?? "";
      const endpoint = (pre.end_point ?? "https://upos-sz-uposbilibili.com").replace(/^https?:\/\//, "");
      const uposPath = uposUri.replace(/^upos:\/\//, "");

      const uploadRes = await fetch(`https://${endpoint}/${uposPath}`, {
        method: "POST",
        headers: {
          Cookie: this.cookieHeader(),
          "X-Upos-Auth": pre.auth ?? "",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(videoBuffer.byteLength),
        },
        body: videoBuffer,
      });
      if (!uploadRes.ok) {
        return { success: false, error: `B站上传失败：HTTP ${uploadRes.status}` };
      }

      const parts = [{ partNumber: 1, etag: await uploadRes.text() }];
      await fetch(`https://${endpoint}/${uposPath}?output=json`, {
        method: "POST",
        headers: { Cookie: this.cookieHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ parts }),
      });

      const addRes = await fetch(`${MEMBER_BASE}/x/vu/web/add/v2`, {
        method: "POST",
        headers: {
          Cookie: this.cookieHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          copyright: 1,
          source: "",
          tid: 122,
          cover: input.coverPath ?? "",
          title: input.title,
          tag: "",
          desc: (input.options?.description as string) ?? "",
          videos: [{ filename: uposPath, title: input.title, cid: pre.biz_id }],
        }),
      });
      const addJson = (await addRes.json()) as BiliAddResponse;
      if (addJson.code !== 0) {
        return { success: false, error: `B站发布失败：${addJson.message ?? JSON.stringify(addJson)}` };
      }

      const bvid = addJson.data?.bvid;
      return {
        success: true,
        platformPostId: bvid,
        postUrl: bvid ? `https://www.bilibili.com/video/${bvid}` : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}