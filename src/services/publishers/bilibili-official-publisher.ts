import { readFile } from "node:fs/promises";
import type { Publisher, PublishInput, PublishOutput } from "./types.js";
import { resolveAccountCredential } from "../credential-resolver.js";

const MEMBER_BASE = "https://member.bilibili.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** 当前 Web 投稿端的上传 profile（旧 ugcfr/pc3 已于 2026 年前后下线，调用一律 403 HTML） */
const UPLOAD_PROFILE = "ugcfx/bup";

interface BiliPreUpload {
  OK?: number;
  auth?: string;
  biz_id?: number;
  chunk_size?: number;
  endpoint?: string;
  endpoints?: string[];
  put_query?: string;
  upos_uri?: string;
  error?: number;
}

interface BiliAddResponse {
  code?: number;
  message?: string;
  data?: { bvid?: string; aid?: number };
}

/**
 * Bilibili publisher using the member web upload (upos chunked) + submit API.
 *
 * Credentials (stored in platform_credentials):
 *   - access_token: the member SESSDATA cookie value
 *   - csrf: the bili_jct cookie value
 *
 * Flow (与当前 york 投稿前端一致，2026-08 逆向验证):
 *   1. GET  /preupload?profile=ugcfx/bup&r=upos   → auth/biz_id/chunk_size/endpoint/upos_uri
 *   2. POST {endpoint}{upos_uri}?uploads&output=json&profile&partsize&biz_id&filesize → upload_id
 *      （filesize 必传，缺了 upos 一律 400 InvalidArgument）
 *   3. PUT  ?partNumber=N&uploadId&chunk=N-1      → MULTIPART_PUT_SUCCESS
 *   4. POST ?output=json&name&uploadId&biz_id&profile  parts → OK:1
 *   5. POST /x/vu/web/add/v3?csrf=                → bvid（v2 已 404 下线）
 */
export class BilibiliOfficialPublisher implements Publisher {
  readonly platform = "bilibili";
  readonly name = "哔哩哔哩";

  isConfigured(accountId?: string): boolean {
    return !!(
      resolveAccountCredential(this.platform, accountId, "access_token") &&
      resolveAccountCredential(this.platform, accountId, "csrf")
    );
  }

  private cookieHeader(accountId?: string): string {
    const sess = resolveAccountCredential(this.platform, accountId, "access_token") ?? "";
    const csrf = resolveAccountCredential(this.platform, accountId, "csrf") ?? "";
    return `SESSDATA=${sess}; bili_jct=${csrf}`;
  }

  /**
   * 上传封面到 B站图床，返回可投稿引用的 URL。
   * 实测（2026-08-06）：/x/vu/web/cover/up 只接受 base64 dataURL 字符串字段
   * （multipart 文件字段返回 -400 请求错误）；投稿 add/v3 要求封面必须来自该接口。
   */
  private async uploadCover(coverPath: string, csrf: string, accountId?: string): Promise<string | undefined> {
    try {
      const img = await readFile(coverPath);
      const mime = /\.png$/i.test(coverPath) ? "image/png" : "image/jpeg";
      const form = new FormData();
      form.append("cover", `data:${mime};base64,${img.toString("base64")}`);
      form.append("csrf", csrf);
      const res = await fetch(`${MEMBER_BASE}/x/vu/web/cover/up`, {
      signal: AbortSignal.timeout(60_000), // 批次10.3
        method: "POST",
        headers: { Cookie: this.cookieHeader(accountId), "User-Agent": UA, Referer: `${MEMBER_BASE}/york/videoup` },
        body: form,
      });
      const data = (await res.json().catch(() => null)) as { code?: number; data?: { url?: string } } | null;
      return data?.code === 0 ? data.data?.url : undefined;
    } catch {
      return undefined;
    }
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const accountId = input.accountId;
    const csrf = resolveAccountCredential(this.platform, accountId, "csrf");
    if (!csrf) {
      return { success: false, error: "缺少哔哩哔哩 csrf (bili_jct)" };
    }

    try {
      const videoBuffer = await readFile(input.videoPath);
      const size = videoBuffer.byteLength;
      const cookie = this.cookieHeader(accountId);

      // 1. preupload
      const preRes = await fetch(
        `${MEMBER_BASE}/preupload?name=video.mp4&size=${size}&profile=${encodeURIComponent(UPLOAD_PROFILE)}&r=upos`,
        { headers: { Cookie: cookie, "User-Agent": UA, Referer: `${MEMBER_BASE}/york/videoup` } },
      );
      const pre = (await preRes.json().catch(() => null)) as BiliPreUpload | null;
      if (!pre || pre.OK !== 1 || !pre.auth || !pre.upos_uri || !pre.endpoint) {
        return {
          success: false,
          error: `B站预上传失败：HTTP ${preRes.status} ${pre ? JSON.stringify(pre).slice(0, 200) : "非 JSON 响应（登录态可能失效，请到发布中心重测）"}`,
        };
      }

      const uposPath = pre.upos_uri.replace(/^upos:\/\//, "");
      const base = `https:${pre.endpoint}/${uposPath}`;
      const uposHeaders = { "X-Upos-Auth": pre.auth, "User-Agent": UA };
      const chunkSize = pre.chunk_size && pre.chunk_size > 0 ? pre.chunk_size : 10 * 1024 * 1024;

      // 2. init multipart（uploadsQuery 四参数缺一不可，尤其 filesize）
      const initQuery =
        `uploads&output=json&profile=${encodeURIComponent(UPLOAD_PROFILE)}` +
        `&partsize=${chunkSize}&biz_id=${pre.biz_id}&filesize=${size}`;
      const initRes = await fetch(`${base}?${initQuery}`, { method: "POST", headers: uposHeaders });
      const initJson = (await initRes.json().catch(() => null)) as { upload_id?: string } | null;
      if (!initRes.ok || !initJson?.upload_id) {
        return { success: false, error: `B站上传初始化失败：HTTP ${initRes.status}` };
      }
      const uploadId = initJson.upload_id;

      // 3. chunk upload（顺序上传，单块失败重试 3 次）
      const parts: Array<{ partNumber: number; etag: string }> = [];
      const totalChunks = Math.ceil(size / chunkSize);
      for (let idx = 0; idx < totalChunks; idx++) {
        const partNumber = idx + 1;
        const chunk = videoBuffer.subarray(idx * chunkSize, Math.min(size, (idx + 1) * chunkSize));
        let ok = false;
        let lastStatus = 0;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const putRes = await fetch(
            `${base}?partNumber=${partNumber}&uploadId=${uploadId}&chunk=${idx}`,
            {
      signal: AbortSignal.timeout(60_000), // 批次10.3
              method: "PUT",
              headers: { ...uposHeaders, "Content-Type": "application/octet-stream" },
              body: chunk,
            },
          );
          lastStatus = putRes.status;
          ok = putRes.ok;
          if (!ok) await putRes.text().catch(() => "");
        }
        if (!ok) {
          return { success: false, error: `B站分片 ${partNumber}/${totalChunks} 上传失败：HTTP ${lastStatus}` };
        }
        parts.push({ partNumber, etag: "etag" }); // upos complete 不校验 etag 内容
      }

      // 4. complete multipart
      const completeRes = await fetch(
        `${base}?output=json&name=video.mp4&uploadId=${uploadId}&biz_id=${pre.biz_id}&profile=${encodeURIComponent(UPLOAD_PROFILE)}`,
        {
      signal: AbortSignal.timeout(60_000), // 批次10.3
          method: "POST",
          headers: { ...uposHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ parts }),
        },
      );
      const completeJson = (await completeRes.json().catch(() => null)) as { OK?: number } | null;
      if (!completeRes.ok || completeJson?.OK !== 1) {
        return { success: false, error: `B站上传完成确认失败：HTTP ${completeRes.status}` };
      }

      // 5. submit（add/v3，v2 已下线 404；filename 用 upos key 去扩展名）
      // 封面：add/v3 要求封面必须先经 /x/vu/web/cover/up 上传，拒绝外部链接/本地路径
      let coverUrl = "";
      if (input.coverPath) {
        coverUrl = (await this.uploadCover(input.coverPath, csrf, accountId)) ?? "";
      }
      const biliFilename = uposPath.split("/").pop()!.replace(/\.[^.]+$/, "");
      const addRes = await fetch(`${MEMBER_BASE}/x/vu/web/add/v3?csrf=${encodeURIComponent(csrf)}`, {
      signal: AbortSignal.timeout(60_000), // 批次10.3
        method: "POST",
        headers: {
          Cookie: cookie,
          "User-Agent": UA,
          Referer: `${MEMBER_BASE}/york/videoup`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          copyright: 1,
          source: "",
          tid: 122,
          cover: coverUrl,
          title: input.title,
          tag: "",
          desc: (input.options?.description as string) ?? "",
          videos: [{ filename: biliFilename, title: input.title, cid: pre.biz_id }],
        }),
      });
      const addJson = (await addRes.json().catch(() => null)) as BiliAddResponse | null;
      if (!addJson) {
        return { success: false, error: `B站提交投稿失败：HTTP ${addRes.status} 非 JSON 响应（登录态可能失效）` };
      }
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
