import { loadConfig } from "../config.js";

const BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

export interface BailianJobResult {
  taskId: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  progress: number;
  videoUrl?: string;
  error?: string;
}

export class BailianClient {
  private async apiKey(): Promise<string> {
    const config = await loadConfig();
    const key = config.bailian?.apiKey ?? process.env.BAILIAN_API_KEY;
    if (!key) throw new Error("Missing Bailian API key");
    return key;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const key = await this.apiKey();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bailian API ${path} error: ${res.status} ${text}`);
    return JSON.parse(text);
  }

  async submitVideo(imageUrl: string, audioUrl: string): Promise<string> {
    const data = (await this.request("/services/aigc/image2video/video-synthesis/", {
      method: "POST",
      body: JSON.stringify({
        model: "liveportrait",
        input: { image_url: imageUrl, audio_url: audioUrl },
      }),
    })) as { output: { task_id: string } };
    const taskId = data.output?.task_id;
    if (!taskId) throw new Error("Bailian submit did not return task_id");
    return taskId;
  }

  async queryVideo(taskId: string): Promise<BailianJobResult> {
    const data = (await this.request(`/tasks/${taskId}`)) as {
      output: { task_status: string; video_url?: string; message?: string };
    };
    const output = data.output ?? {};
    const status = (output.task_status ?? "UNKNOWN") as BailianJobResult["status"];
    const progress = status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 60 : status === "PENDING" ? 10 : 0;
    return { taskId, status, progress, videoUrl: output.video_url, error: output.message };
  }
}
