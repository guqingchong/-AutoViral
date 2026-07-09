const BASE = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function fetchConfig() {
  return request<{
    interval: string;
    model: string;
    autoRun: boolean;
    port: number;
    maxReports: number;
    reportsToFeed: number;
  }>("/api/config");
}

export async function updateConfig(config: Record<string, unknown>) {
  return request<Record<string, unknown>>("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function triggerEvolution() {
  return request<{ triggered: boolean }>("/api/trigger", { method: "POST" });
}

export async function fetchStatus() {
  return request<{
    state: string;
    lastRun: string | null;
    nextRun: string | null;
    isSchedulerActive: boolean;
  }>("/api/status");
}

// ---------------------------------------------------------------------------
// Work types
// ---------------------------------------------------------------------------

export type WorkType = "short-video" | "image-text";
export type ContentCategory = "anxiety" | "conflict" | "comedy" | "envy" | "other";
export type WorkStatus = "draft" | "creating" | "ready" | "failed";

export interface WorkSummary {
  id: string;
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  status: WorkStatus;
  platforms: string[];
  coverImage?: string;
  coverIsVideo?: boolean;
  updatedAt: string;
}

export interface PipelineStep {
  name: string;
  status: "pending" | "active" | "done" | "skipped" | "evaluating" | "eval_blocked";
  startedAt?: string;
  completedAt?: string;
  note?: string;
}

export interface Work {
  id: string;
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  status: WorkStatus;
  platforms: string[];
  pipeline: Record<string, PipelineStep>;
  cliSessionId?: string;
  coverImage?: string;
  topicHint?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Work API
// ---------------------------------------------------------------------------

export async function fetchWorks(): Promise<WorkSummary[]> {
  const data = await request<{ works: WorkSummary[] }>("/api/works");
  return data.works;
}

export async function fetchWork(id: string): Promise<Work> {
  return request<Work>(`/api/works/${encodeURIComponent(id)}`);
}

export async function createWorkApi(input: {
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  videoSource?: string;
  videoSearchQuery?: string;
  platforms?: string[];
  topicHint?: string;
}): Promise<Work> {
  return request<Work>("/api/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteWorkApi(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/works/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function updateWorkApi(id: string, updates: Partial<Work>): Promise<Work> {
  return request<Work>(`/api/works/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function startWorkSession(id: string): Promise<{ status: string; workId: string; step?: string }> {
  return request(`/api/works/${encodeURIComponent(id)}/session`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Generation API
// ---------------------------------------------------------------------------

export async function generateImage(opts: any) {
  return post<any>("/api/generate/image", opts);
}

export async function generateVideo(opts: any) {
  return post<any>("/api/generate/video", opts);
}

export async function fetchProviders() {
  return get<any>("/api/generate/providers");
}

// ---------------------------------------------------------------------------
// Shared assets & Trends
// ---------------------------------------------------------------------------

export interface AssetFile {
  name: string;
  size: number;
  mtime: string;
  category: string;
}

export interface UploadResult {
  uploaded: (AssetFile & { url: string })[];
}

export async function fetchSharedAssets(): Promise<Record<string, AssetFile[]>> {
  return get<Record<string, AssetFile[]>>("/api/shared-assets");
}

export async function uploadAsset(category: string, files: FileList | File[]): Promise<UploadResult> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  const res = await fetch(`/api/shared-assets/${encodeURIComponent(category)}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAsset(category: string, filename: string): Promise<void> {
  const res = await fetch(`/api/shared-assets/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function moveAsset(from: string, to: string, file: string): Promise<void> {
  const res = await fetch("/api/shared-assets/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, file }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function fetchTrends(platform: string) {
  return get<any>(`/api/trends/${platform}`);
}

export async function refreshTrends() {
  return post<any>("/api/trends/refresh", {});
}

// ---------------------------------------------------------------------------
// Evaluation API
// ---------------------------------------------------------------------------

export interface EvalIssue {
  severity: "critical" | "major" | "minor";
  description: string;
  file?: string;
}

export interface EvalResult {
  step: string;
  attempt: number;
  verdict: "pass" | "fail";
  scores: Record<string, number>;
  issues: EvalIssue[];
  suggestions: string[];
  timestamp: string;
}

export async function toggleEvalMode(workId: string): Promise<{ evaluationMode: boolean }> {
  return post<{ evaluationMode: boolean }>(`/api/works/${encodeURIComponent(workId)}/eval/toggle`, {});
}

export async function forcePassEval(workId: string, step: string, nextStep?: string): Promise<{ pipeline: Record<string, PipelineStep> }> {
  return post<{ pipeline: Record<string, PipelineStep> }>(`/api/works/${encodeURIComponent(workId)}/eval/force-pass`, { step, nextStep });
}

export async function retryWithGuidance(workId: string, step: string, guidance: string): Promise<void> {
  await post(`/api/works/${encodeURIComponent(workId)}/eval/retry`, { step, guidance });
}

export async function fetchEvalResults(workId: string, step: string): Promise<EvalResult[]> {
  const data = await get<{ results: EvalResult[] }>(`/api/works/${encodeURIComponent(workId)}/eval/results/${encodeURIComponent(step)}`);
  return data.results;
}

// ---------------------------------------------------------------------------
// Topics API
// ---------------------------------------------------------------------------

export interface Topic {
  id: number;
  platform?: string;
  title: string;
  description?: string;
  heat?: number;
  competition?: string;
  opportunity?: string;
  emotion_type?: string;
  emotion_subtype?: string;
  tags: string[];
  content_angles: string[];
  example_hook?: string;
  category?: string;
  status: string;
}

export async function fetchTopics(platform?: string): Promise<Topic[]> {
  const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
  const data = await request<{ topics: Topic[] }>(`/api/topics${qs}`);
  return data.topics;
}

export async function convertTopicToWork(id: number, opts?: { platforms?: string[]; type?: "short-video" | "image-text" }) {
  return post<{ workId: string }>(`/api/topics/${encodeURIComponent(id)}/convert`, opts ?? {});
}

// ---------------------------------------------------------------------------
// Digital Human API
// ---------------------------------------------------------------------------

export interface Avatar {
  id: string;
  name: string;
  status: "training" | "ready" | "failed";
  source: "chanjing" | "bailian";
  provider_avatar_id?: string;
  preview_url?: string;
  reference_video_path?: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DigitalHumanJob {
  id: string;
  work_id?: string;
  avatar_id: string;
  audio_path: string;
  script_id?: number;
  provider: "chanjing" | "bailian";
  provider_job_id?: string;
  status: "pending" | "queued" | "running" | "done" | "failed";
  progress: number;
  result_url?: string;
  result_local_path?: string;
  estimated_cost: number;
  actual_cost: number;
  error?: string;
  created_at: string;
  updated_at: string;
}

export async function fetchAvatars(): Promise<Avatar[]> {
  const data = await request<{ avatars: Avatar[] }>("/api/digital-humans/avatars");
  return data.avatars;
}

export async function uploadAvatar(name: string, file: File): Promise<Avatar> {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  const res = await fetch("/api/digital-humans/avatars", { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importAvatar(name: string, providerAvatarId: string): Promise<Avatar> {
  return post<Avatar>("/api/digital-humans/avatars", { name, providerAvatarId });
}

export async function fetchDigitalHumanJobs(): Promise<DigitalHumanJob[]> {
  const data = await request<{ jobs: DigitalHumanJob[] }>("/api/digital-humans/jobs");
  return data.jobs;
}

export async function submitDigitalHumanJob(input: {
  avatarId: string;
  audioUrl: string;
  workId?: string;
  scriptId?: number;
  estimatedCost?: number;
  fallbackOnFailure?: boolean;
}): Promise<DigitalHumanJob> {
  return post<DigitalHumanJob>("/api/digital-humans/jobs", input);
}

export async function refreshDigitalHumanJob(id: string): Promise<DigitalHumanJob> {
  return post<DigitalHumanJob>(`/api/digital-humans/jobs/${encodeURIComponent(id)}/refresh`, {});
}

// ---------------------------------------------------------------------------
// Asset Library API
// ---------------------------------------------------------------------------

export interface AssetLibraryItem {
  id: number;
  name: string;
  file_path: string;
  category: "characters" | "scenes" | "music" | "templates" | "branding" | "general";
  type: "image" | "video" | "audio" | "font" | "other";
  tags: string[];
  source: "upload" | "pexels" | "pixabay" | "unsplash" | "self-generated" | "unknown";
  license: "cc0" | "commercial" | "needs-review" | "unknown";
  compliance_status: "pending" | "passed" | "failed";
  metadata: Record<string, unknown>;
  usage_count: number;
  url?: string;
  created_at: string;
  updated_at: string;
}

export async function fetchLibraryAssets(category?: AssetLibraryItem["category"]): Promise<AssetLibraryItem[]> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : "";
  const data = await request<{ assets: AssetLibraryItem[] }>(`/api/assets${qs}`);
  return data.assets;
}

export async function uploadLibraryAsset(
  file: File,
  category: AssetLibraryItem["category"],
  source: AssetLibraryItem["source"],
  license: AssetLibraryItem["license"],
  tags: string,
  metadata?: Record<string, unknown>,
): Promise<AssetLibraryItem> {
  const form = new FormData();
  form.append("file", file);
  form.append("category", category);
  form.append("source", source);
  form.append("license", license);
  form.append("tags", tags);
  if (metadata) form.append("metadata", JSON.stringify(metadata));
  const res = await fetch("/api/assets", { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateLibraryAsset(
  id: number,
  updates: Partial<Omit<AssetLibraryItem, "id" | "created_at" | "updated_at">>,
): Promise<AssetLibraryItem> {
  return request<AssetLibraryItem>(`/api/assets/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteLibraryAsset(id: number): Promise<void> {
  await request<{ deleted: boolean }>(`/api/assets/${id}`, { method: "DELETE" });
}

export async function recheckAssetCompliance(id: number): Promise<AssetLibraryItem> {
  return post<AssetLibraryItem>(`/api/assets/${id}/compliance`, {});
}

// ---------------------------------------------------------------------------
// Template & Render API
// ---------------------------------------------------------------------------

export interface Template {
  id: string;
  name: string;
  contentForm?: string;
  canvas: { width: number; height: number; fps: number };
  variables: Array<{ name: string; type: string; label?: string; default?: string | number }>;
  layers: Record<string, unknown>[];
  audio: Record<string, unknown>[];
  subtitles?: Record<string, unknown>;
  transitions: Record<string, unknown>[];
  previewUrl?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderJob {
  id: string;
  work_id?: string;
  template_id?: string;
  output_path?: string;
  status: string;
  progress: number;
  duration?: number;
  current_time?: number;
  error?: string;
  created_at: string;
}

export async function fetchTemplates(status?: string, contentForm?: string): Promise<Template[]> {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (contentForm) qs.set("contentForm", contentForm);
  const data = await request<{ templates: Template[] }>(`/api/templates?${qs.toString()}`);
  return data.templates;
}

export async function fetchTemplate(id: string): Promise<Template> {
  return request<Template>(`/api/templates/${encodeURIComponent(id)}`);
}

export async function createTemplate(template: Partial<Template>): Promise<Template> {
  return post<Template>("/api/templates", template);
}

export async function updateTemplateApi(id: string, updates: Partial<Template>): Promise<Template> {
  return request<Template>(`/api/templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteTemplateApi(id: string): Promise<void> {
  await request(`/api/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function renderPreview(id: string, variables?: Record<string, string | number>): Promise<{ previewUrl: string }> {
  return post<{ previewUrl: string }>(`/api/templates/${encodeURIComponent(id)}/preview`, { variables });
}

export async function fetchRenderJobs(status?: string): Promise<RenderJob[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await request<{ jobs: RenderJob[] }>(`/api/render-jobs${qs}`);
  return data.jobs;
}

export async function startWorkRender(workId: string, opts: {
  templateId: string;
  digitalHumanVideo: string;
  voiceAudio: string;
  subtitlePath?: string;
  bgmPath?: string;
  assets?: Record<string, string>;
  variables?: Record<string, string | number>;
}) {
  return post<{ jobId: string; outputPath: string; status: string }>(`/api/works/${encodeURIComponent(workId)}/render`, opts);
}
