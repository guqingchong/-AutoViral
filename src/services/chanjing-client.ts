import { loadConfig } from "../config.js";

const BASE_URL = "https://open-api.chanjing.cc";

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export interface ChanjingAvatar {
  id: string;
  name: string;
  previewUrl?: string;
}

export interface ChanjingSubmitResult {
  jobId: string;
}

export interface ChanjingJobResult {
  status: "pending" | "processing" | "success" | "failed";
  progress: number;
  videoUrl?: string;
  error?: string;
}

export class ChanjingClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  private async ensureCredentials(): Promise<{ appId: string; secretKey: string }> {
    const config = await loadConfig();
    const appId = config.chanjing?.appId ?? process.env.CHANJING_APP_ID;
    const secretKey = config.chanjing?.secretKey ?? process.env.CHANJING_SECRET_KEY;
    if (!appId || !secretKey) throw new Error("Missing ChanJing appId or secretKey");
    return { appId, secretKey };
  }

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const { appId, secretKey } = await this.ensureCredentials();
    const url = `${BASE_URL}/openapi/v1/token?appid=${encodeURIComponent(appId)}&secretKey=${encodeURIComponent(secretKey)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`ChanJing token error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as TokenResponse;
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.token;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const token = await this.getAccessToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`ChanJing API ${path} error: ${res.status} ${text}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  async listAvatars(): Promise<ChanjingAvatar[]> {
    const data = (await this.request("/openapi/v1/avatar/list")) as {
      data?: { avatars?: Array<{ avatar_id: string; name: string; preview_url?: string }> };
    };
    const list = data.data?.avatars ?? [];
    return list.map((a) => ({ id: a.avatar_id, name: a.name, previewUrl: a.preview_url }));
  }

  async createAvatar(params: { name: string; videoUrl: string }): Promise<{ avatarId: string; status: string }> {
    const data = (await this.request("/openapi/v1/avatar/create", {
      method: "POST",
      body: JSON.stringify({ name: params.name, video_url: params.videoUrl }),
    })) as { data?: { avatar_id: string; status?: string } };
    const avatarId = data.data?.avatar_id;
    if (!avatarId) throw new Error("ChanJing avatar/create did not return avatar_id");
    return { avatarId, status: data.data?.status ?? "training" };
  }

  async submitVideo(avatarId: string, audioUrl: string, payload?: { text?: string; backgroundUrl?: string }): Promise<ChanjingSubmitResult> {
    const body = { avatar_id: avatarId, audio_url: audioUrl, ...payload };
    const data = (await this.request("/openapi/v1/video/create", {
      method: "POST",
      body: JSON.stringify(body),
    })) as { data?: { job_id: string } };
    const jobId = data.data?.job_id;
    if (!jobId) throw new Error("ChanJing video/create did not return job_id");
    return { jobId };
  }

  async queryVideo(jobId: string): Promise<ChanjingJobResult> {
    const data = (await this.request(`/openapi/v1/video/result?job_id=${encodeURIComponent(jobId)}`)) as {
      data?: { status: number | string; progress?: number; video_url?: string; error_msg?: string };
    };
    const d = data.data ?? {} as { status?: number | string; progress?: number; video_url?: string; error_msg?: string };
    const statusCode = typeof d.status === "number" ? d.status : Number(d.status);
    let status: ChanjingJobResult["status"] = "pending";
    if (statusCode === 2) status = "processing";
    else if (statusCode === 3) status = "success";
    else if (statusCode >= 4) status = "failed";
    return {
      status,
      progress: d.progress ?? (status === "success" ? 100 : status === "processing" ? 50 : 0),
      videoUrl: d.video_url,
      error: d.error_msg,
    };
  }
}
