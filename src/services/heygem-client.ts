import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig } from "../config.js";

export interface HeyGemJobInfo {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  processing_time_seconds: number | null;
  error: string | null;
}

async function endpoint(): Promise<{ base: string; headers: Record<string, string> }> {
  const config = await loadConfig();
  const base = config.heygem?.baseUrl?.replace(/\/$/, "");
  if (!base) throw new Error("未配置 HeyGem 实例地址（heygem.baseUrl）");
  const token = config.heygem?.apiToken;
  if (!token) throw new Error("未配置 HeyGem API Token（heygem.apiToken）");
  return { base, headers: { Authorization: `Bearer ${token}` } };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const { base, headers } = await endpoint();
    const res = await fetch(`${base}/api/health`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, timeoutMessage: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(timeoutMessage);
    }
    throw err;
  }
}

export async function submitJob(audioPath: string, videoPath: string, mode: "repeat" | "pingpong" = "pingpong"): Promise<string> {
  const { base, headers } = await endpoint();
  const form = new FormData();
  form.append("audio_file", new Blob([await readFile(audioPath)]), basename(audioPath));
  form.append("video_file", new Blob([await readFile(videoPath)]), basename(videoPath));
  form.append("short_video_mode", mode);
  const res = await fetchWithTimeout(`${base}/api/jobs`, { method: "POST", headers, body: form }, 120000, "HeyGem 提交超时");
  if (!res.ok) throw new Error(`HeyGem 提交失败: HTTP ${res.status}`);
  const data = (await res.json()) as { job_id?: string };
  if (!data.job_id) throw new Error("HeyGem 未返回 job_id");
  return data.job_id;
}

export async function getJob(jobId: string): Promise<HeyGemJobInfo> {
  const { base, headers } = await endpoint();
  const res = await fetchWithTimeout(`${base}/api/jobs/${encodeURIComponent(jobId)}`, { headers }, 15000, "HeyGem 查询超时");
  if (!res.ok) throw new Error(`HeyGem 查询失败: HTTP ${res.status}`);
  const data = (await res.json()) as HeyGemJobInfo;
  return {
    job_id: data.job_id,
    status: data.status,
    processing_time_seconds: data.processing_time_seconds ?? null,
    error: data.error ?? null,
  };
}

export async function downloadResult(jobId: string, destPath: string): Promise<void> {
  const { base, headers } = await endpoint();
  const res = await fetchWithTimeout(`${base}/api/jobs/${encodeURIComponent(jobId)}/result`, { headers }, 300000, "HeyGem 下载超时");
  if (!res.ok) throw new Error(`HeyGem 下载失败: HTTP ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

/** 批次9.1(DH-3):best-effort 取消 HeyGem 侧任务——超时/失败时调用,
 *  避免 GPU 侧继续跑无人认领的任务(已付费结果丢失)。
 *  注意:HeyGem 是否支持 DELETE /api/jobs/:id 未经官方文档证实,失败静默忽略。 */
export async function cancelJob(jobId: string): Promise<void> {
  try {
    const { base, headers } = await endpoint();
    await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* best-effort */ }
}
