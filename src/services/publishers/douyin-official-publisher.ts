import { readFile } from "node:fs/promises";
import { Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { resolveAccountCredential } from "../credential-resolver.js";

export class DouyinOfficialPublisher implements Publisher {
  readonly platform = "douyin";
  readonly name = "抖音开放平台";

  isConfigured(accountId?: string): boolean {
    const appKey = resolveAccountCredential(this.platform, accountId, "app_key");
    const accessToken = resolveAccountCredential(this.platform, accountId, "access_token");
    const openId = resolveAccountCredential(this.platform, accountId, "open_id");
    return !!(appKey && accessToken && openId);
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const accessToken = resolveAccountCredential(this.platform, input.accountId, "access_token");
    const openId = resolveAccountCredential(this.platform, input.accountId, "open_id");
    if (!accessToken || !openId) {
      return { success: false, error: "缺少抖音开放平台 access_token / open_id" };
    }

    try {
      const videoBuffer = await readFile(input.videoPath);
      const uploadForm = new FormData();
      uploadForm.append("video", new Blob([videoBuffer]), "video.mp4");

      const uploadRes = await fetch(
        `https://open.douyin.com/video/upload/?access_token=${encodeURIComponent(accessToken)}&open_id=${encodeURIComponent(openId)}`,
        { method: "POST", body: uploadForm }
      );
      const uploadJson = await uploadRes.json() as Record<string, unknown>;
      const uploadData = uploadJson.data as Record<string, unknown> | undefined;
      if (uploadData?.error_code !== 0) {
        return {
          success: false,
          error: `抖音上传失败：${uploadData?.description ?? JSON.stringify(uploadJson)}`,
        };
      }

      const videoData = uploadData?.video as Record<string, unknown> | undefined;
      const videoId = videoData?.video_id as string | undefined;
      if (!videoId) {
        return { success: false, error: "抖音上传未返回 video_id" };
      }

      const createRes = await fetch(
        `https://open.douyin.com/video/create/?access_token=${encodeURIComponent(accessToken)}&open_id=${encodeURIComponent(openId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video_id: videoId, title: input.title }),
        }
      );
      const createJson = await createRes.json() as Record<string, unknown>;
      const createData = createJson.data as Record<string, unknown> | undefined;
      if (createData?.error_code !== 0) {
        return {
          success: false,
          error: `抖音发布失败：${createData?.description ?? JSON.stringify(createJson)}`,
        };
      }

      const itemId = createData?.item_id as string | undefined;
      return {
        success: true,
        platformPostId: itemId,
        postUrl: itemId ? `https://www.douyin.com/video/${itemId}` : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
