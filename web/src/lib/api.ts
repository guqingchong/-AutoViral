const BASE = "";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
    message?: string,
  ) {
    super(message || `${status}`);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* no body */ }
    throw new ApiError(res.status, body.code as string | undefined, (body.error as string) || `${res.status} ${res.statusText}`);
  }
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
// Account types (Phase 7)
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
  platform: string;
  tone_profile: Record<string, unknown>;
  status: "active" | "inactive";
  /** 平台内默认账号标记。后端 GET /api/accounts 原样返回 SQLite 的 is_default(0/1) */
  is_default?: number;
  created_at: string;
  updated_at: string;
}

export async function fetchAccounts(): Promise<Account[]> {
  const data = await request<{ accounts: Account[] }>("/api/accounts");
  return data.accounts;
}

export async function fetchAccount(id: string): Promise<Account> {
  return request<Account>(`/api/accounts/${encodeURIComponent(id)}`);
}

export async function createAccountApi(input: { name: string; platform: string; tone_profile?: Record<string, unknown> }): Promise<Account> {
  return post<Account>("/api/accounts", input);
}

export async function updateAccountApi(id: string, updates: { name?: string; platform?: string; tone_profile?: Record<string, unknown>; status?: string }): Promise<Account> {
  return request<Account>(`/api/accounts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteAccountApi(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 按账号触发浏览器登录（仅 RPA 平台：抖音/小红书/知乎/视频号） */
export async function loginAccount(accountId: string): Promise<{ success: boolean }> {
  return post<{ success: boolean }>(`/api/accounts/${encodeURIComponent(accountId)}/login`, {});
}

/** 设为该平台默认账号（发布未指定 accountId 时后端用它） */
export async function setDefaultAccount(accountId: string): Promise<{ success: boolean }> {
  return post<{ success: boolean }>(`/api/accounts/${encodeURIComponent(accountId)}/default`, {});
}

// ---------------------------------------------------------------------------
// Schedule / Calendar types (Phase 8)
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  id: string;
  work_id?: string;
  account_id?: string;
  title: string;
  description: string;
  scheduled_date: string;
  scheduled_time?: string;
  platform: string;
  content_type: "short-video" | "image-text";
  status: "planned" | "in_progress" | "done" | "cancelled";
  color?: string;
  created_at: string;
  updated_at: string;
}

export async function fetchCalendarRange(from: string, to: string): Promise<ScheduleEntry[]> {
  const data = await request<{ entries: ScheduleEntry[] }>(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  return data.entries;
}

export async function fetchCalendarMonth(yearMonth: string): Promise<{ entries: ScheduleEntry[]; counts: Record<string, number> }> {
  return request<{ entries: ScheduleEntry[]; counts: Record<string, number> }>(`/api/calendar/month/${yearMonth}`);
}

export async function createScheduleEntry(input: {
  title: string;
  scheduled_date: string;
  work_id?: string;
  account_id?: string;
  description?: string;
  scheduled_time?: string;
  platform?: string;
  content_type?: string;
  status?: string;
  color?: string;
}): Promise<ScheduleEntry> {
  return post<ScheduleEntry>("/api/calendar", input);
}

export async function updateScheduleEntry(id: string, updates: Partial<ScheduleEntry>): Promise<ScheduleEntry> {
  return request<ScheduleEntry>(`/api/calendar/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export async function deleteScheduleEntry(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/calendar/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Work types
// ---------------------------------------------------------------------------

export type WorkType = "short-video" | "image-text";
export type ContentCategory = "anxiety" | "conflict" | "comedy" | "envy" | "other";
export type WorkStatus = "draft" | "researching" | "planning" | "assetting" | "assembling" | "reviewing" | "approved" | "published" | "failed";

export interface WorkSummary {
  id: string;
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  contentForm?: string;
  status: WorkStatus;
  platforms: string[];
  coverImage?: string;
  coverIsVideo?: boolean;
  /** 审核预览视频 URL（成片，发布中心审核预览优先使用） */
  previewUrl?: string;
  /** 最近一次发布中心打回的审核意见 */
  reviewComment?: string;
  accountId?: string;
  topicId?: number;
  templateId?: string;
  digitalHumanId?: string;
  /** 全自动模式：批量按钮创建 = true（作品卡片 ⚡/🖐 标签数据源） */
  autoMode?: boolean;
  /** 流水线各阶段状态（作品卡片实时进度条） */
  pipeline?: Array<{ key: string; name: string; status: string }>;
  /** 最近活动时间（步骤 started/completed 与 updatedAt 的最大值），进度三态数据源 */
  lastActivityAt?: string | null;
  /** 最近一次失败原因（批次12c，failVisible 落库；复活/推进成功后后端清空） */
  lastError?: string;
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
  contentForm?: string;
  status: WorkStatus;
  platforms: string[];
  pipeline: Record<string, PipelineStep>;
  cliSessionId?: string;
  coverImage?: string;
  topicHint?: string;
  topicId?: number;
  articleId?: number;
  scriptId?: number;
  digitalHumanId?: string;
  templateId?: string;
  accountId?: string;
  estimatedCost?: number;
  actualCost?: number;
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

/** 发布中心打回修改：指定重做阶段 + 审核意见，意见直达 AI 并驱动重做 */
export async function rejectWork(
  id: string,
  stage: string,
  comment: string,
): Promise<{ ok: boolean; status: WorkStatus; delivery: "message" | "session" | "queued" | "none" }> {
  return request(`/api/works/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage, comment }),
  });
}

export async function createWorkApi(input: {
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  videoSource?: string;
  videoSearchQuery?: string;
  platforms?: string[];
  topicHint?: string;
  evalMode?: "standard" | "express";
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
// Work Queue API（作品流水线任务队列）
// ---------------------------------------------------------------------------

export type QueueStatus = "queued" | "running" | "paused" | "done" | "failed";

export interface QueueItemInfo {
  workId: string;
  position: number;
  status: QueueStatus;
  title: string;
  workStatus: string;
}

export async function fetchQueue(): Promise<QueueItemInfo[]> {
  const data = await request<{ items: QueueItemInfo[] }>("/api/queue");
  return data.items;
}

export async function queueAction(
  workId: string,
  action: "prioritize" | "pause" | "resume" | "remove",
): Promise<unknown> {
  return post(`/api/queue/${encodeURIComponent(workId)}/${action}`, {});
}

/** 出队并删除作品（二次确认由调用方做） */
export async function deleteQueueWork(workId: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/queue/${encodeURIComponent(workId)}`, { method: "DELETE" });
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

export async function refreshTrendsStream(platform: string, interests?: string[]) {
  return post<{ sessionKey: string; platform: string }>("/api/trends/refresh-stream", { platform, interests });
}

export async function cancelTrendResearch(sessionKey: string) {
  return post<{ cancelled: boolean }>(`/api/trends/cancel/${encodeURIComponent(sessionKey)}`, {});
}

export async function collectTrends(platform?: string, interests?: string[], accountId?: string) {
  return post<{ collected: number; platform: string; topics: Array<{ id: number; title: string; heat: number }> }>("/api/trends/collect", { platform, interests, accountId });
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

export async function convertTopicToWork(id: number, opts?: { platforms?: string[]; type?: "short-video" | "image-text"; accountId?: string }) {
  return post<{ workId: string }>(`/api/topics/${encodeURIComponent(id)}/convert`, opts ?? {});
}

// ---------------------------------------------------------------------------
// Digital Human API
// ---------------------------------------------------------------------------

export interface Avatar {
  id: string;
  name: string;
  status: "draft" | "training" | "ready" | "failed";
  source: "heygem" | "upload";
  preview_url?: string;
  reference_video_path?: string;
  /** 含 mediaName（形如 media.mp4），用于拼 /avatars/:id/media/:filename 预览 URL */
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
  provider: "heygem";
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

export interface InstanceView {
  state: "ready" | "offline";
  gpuHourlyRateYuan: number;
  idleReminderMinutes: number;
  lastActivityAt: string | null;
  idleMinutes: number;
  consoleUrl: string;
}

export interface DigitalHumanConfigStatus {
  heygemConfigured: boolean;
}

export async function fetchInstanceStatus(): Promise<InstanceView> {
  return get<InstanceView>("/api/digital-humans/instance/status");
}

export async function fetchDigitalHumanConfigStatus(): Promise<DigitalHumanConfigStatus> {
  return get<DigitalHumanConfigStatus>("/api/digital-humans/config-status");
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

export async function deleteAvatarApi(id: string): Promise<void> {
  await request<{ deleted: boolean }>(`/api/digital-humans/avatars/${encodeURIComponent(id)}`, { method: "DELETE" });
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

export async function deleteDigitalHumanJob(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/digital-humans/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function regenerateDigitalHumanJob(id: string): Promise<DigitalHumanJob> {
  return request<DigitalHumanJob>(`/api/digital-humans/jobs/${encodeURIComponent(id)}/regenerate`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Digital Human Batch Render
// ---------------------------------------------------------------------------

export interface DigitalHumanBatchState {
  running: boolean;
  total: number;
  submitted: number;
  done: number;
  failed: number;
  startedAt: string | null;
  errors: Array<{ workId: string; error: string }>;
}

export interface PendingDigitalHumanWork {
  id: string;
  title: string;
}

export async function fetchDigitalHumanBatchPending(): Promise<{ count: number; works: PendingDigitalHumanWork[] }> {
  return get<{ count: number; works: PendingDigitalHumanWork[] }>("/api/digital-humans/batch/pending");
}

export async function runDigitalHumanBatch(): Promise<DigitalHumanBatchState> {
  return post<DigitalHumanBatchState>("/api/digital-humans/batch/run", {});
}

export async function fetchDigitalHumanBatchStatus(): Promise<DigitalHumanBatchState> {
  return get<DigitalHumanBatchState>("/api/digital-humans/batch/status");
}

// ---------------------------------------------------------------------------
// Digital Human Render Pool（渲染池：攒批 + 立即渲染）
// ---------------------------------------------------------------------------

export interface RenderPoolItem {
  jobId: string;
  workId: string;
  title: string;
  queuePosition: number | null;
  status: string;
}

export interface RenderPoolView {
  items: RenderPoolItem[];
  pendingBoot: boolean;
  instance: { state: InstanceView["state"]; consoleUrl: string };
  batch: DigitalHumanBatchState;
}

export async function fetchRenderPool(): Promise<RenderPoolView> {
  return get<RenderPoolView>("/api/digital-humans/render-pool");
}

export async function renderNow(): Promise<DigitalHumanBatchState & { pendingBoot: boolean }> {
  return post<DigitalHumanBatchState & { pendingBoot: boolean }>("/api/digital-humans/render-now", {});
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

export function getAnalyticsRecords(): Promise<{ records: unknown[] }> {
  return request<{ records: unknown[] }>("/api/analytics/records");
}

export function getAnalyticsWorks(platform?: string): Promise<unknown[]> {
  return request<unknown[]>(`/api/analytics/works${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`);
}

export function getAnalyticsInsights(platform?: string): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/api/analytics/insights${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`);
}

export function triggerCollect(): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>("/api/analytics/v2/collect", {});
}

// ---------------------------------------------------------------------------
// Works Dashboard（作品一级数据看板，2026-08-20 重构 Task 9）
// ---------------------------------------------------------------------------

export interface WorkDashboardMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  collects: number;
  completionRate: number | null;
}

export interface WorkDashboardRecord {
  recordId: number;
  platform: string;
  accountId: string | null;
  accountName: string | null;
  status: string;
  publishedAt: string | null;
  /** 无指标记录（如 reviewing）为 null，且不计入 totals */
  metrics: WorkDashboardMetrics | null;
}

export interface WorkDashboardRow {
  workId: string;
  /** 列表接口恒非 null（缺省"未命名"）；详情接口对无记录作品返回 null */
  title: string | null;
  workType: string | null;
  category: string | null;
  publishedAt: string | null;
  platforms: string[];
  /** 各发布记录最新指标求和 */
  totals: { views: number; likes: number; comments: number; shares: number; collects: number };
  records: WorkDashboardRecord[];
}

export interface WorkDashboardSeriesPoint {
  collectedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  collects: number;
}

/** 详情接口响应 = 平铺的 workRow + series（非嵌套） */
export interface WorkDashboardDetail extends WorkDashboardRow {
  /** 近 7 天按发布记录分组的采集序列 */
  series: Array<{ recordId: number; points: WorkDashboardSeriesPoint[] }>;
}

export function getWorksDashboard(params?: {
  platform?: string;
  accountId?: string;
  from?: string;
  to?: string;
}): Promise<{ works: WorkDashboardRow[] }> {
  const qs = new URLSearchParams();
  if (params?.platform) qs.set("platform", params.platform);
  if (params?.accountId) qs.set("accountId", params.accountId);
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  const s = qs.toString();
  return request<{ works: WorkDashboardRow[] }>(`/api/analytics/works-dashboard${s ? `?${s}` : ""}`);
}

export function getWorkDashboard(workId: string): Promise<WorkDashboardDetail> {
  return request<WorkDashboardDetail>(`/api/analytics/works-dashboard/${encodeURIComponent(workId)}`);
}

export function recomputeBaselines(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>("/api/analytics/recompute-baselines", {});
}

export interface CommentFilter {
  publishRecordId?: number;
  sentiment?: string;
  replied?: boolean;
  keyword?: string;
  limit?: number;
}

export function getComments(filter: CommentFilter = {}): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  if (filter.publishRecordId) qs.set("publishRecordId", String(filter.publishRecordId));
  if (filter.sentiment) qs.set("sentiment", filter.sentiment);
  if (filter.replied !== undefined) qs.set("replied", String(filter.replied));
  if (filter.keyword) qs.set("keyword", filter.keyword);
  if (filter.limit) qs.set("limit", String(filter.limit));
  return request<Record<string, unknown>[]>(`/api/comments?${qs.toString()}`);
}

export function suggestReply(commentId: number): Promise<{ tone: string; replies: string[] }> {
  return post(`/api/comments/${commentId}/reply-suggest`, {});
}

export function postReply(commentId: number, content: string): Promise<{ ok: boolean }> {
  return post(`/api/comments/${commentId}/reply`, { content });
}

export function classifyComments(): Promise<{ classified: number }> {
  return post("/api/comments/classify", {});
}

export function listEvolutionRules(ruleType?: string): Promise<Record<string, unknown>[]> {
  return request<Record<string, unknown>[]>(`/api/evolution/rules${ruleType ? `?ruleType=${encodeURIComponent(ruleType)}` : ""}`);
}

export function updateEvolutionRule(id: number, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/api/evolution/rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
}

export function deleteEvolutionRule(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/evolution/rules/${id}`, { method: "DELETE" });
}

export function generateEvolutionRules(insights: unknown[]): Promise<Record<string, unknown>[]> {
  return post<Record<string, unknown>[]>("/api/evolution/generate", { insights });
}

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
  /** 模板级品牌 logo(2026-08-13):视频渲染与图文卡片共用 */
  branding?: {
    logoAsset: string;
    position: string;
    margin?: number;
    width?: number;
    opacity?: number;
  };
  previewUrl?: string;
  /** poster.png 静态图 URL（存在时由后端返回），模板卡片优先用它展示 */
  posterUrl?: string;
  /** 分幕故事板单帧 URL 列表(2026-08-13):点击预览时灯箱逐张查看 */
  frameUrls?: string[];
  status: string;
  /** 模板被渲染使用的次数（自进化偏好信号） */
  usageCount?: number;
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

export async function renderPreview(id: string, variables?: Record<string, string | number>): Promise<{ previewUrl: string; posterUrl?: string }> {
  return post<{ previewUrl: string; posterUrl?: string }>(`/api/templates/${encodeURIComponent(id)}/preview`, { variables });
}

// ── DesignBrief 意图稿(2026-08-25) ──
export interface DesignBrief {
  styleSummary: string;
  palette: Array<{ hex: string; role: string; note?: string }>;
  layout: Array<{ region: string; content: string; position: string }>;
  elements: string[];
  motion: { entrance: string; loop: string };
  referenceNotes?: string;
  sourceText: string;
}

export async function createBrief(input: {
  style: string;
  orientation?: "portrait" | "landscape";
  withDigitalHuman?: boolean;
  referenceImage?: { data: string; mediaType: string };
}): Promise<{ briefId: string; brief: DesignBrief }> {
  return post<{ briefId: string; brief: DesignBrief }>("/api/templates/brief", input);
}

export async function chatBrief(briefId: string, message: string): Promise<{ brief: DesignBrief; diffSummary: string }> {
  return post<{ brief: DesignBrief; diffSummary: string }>(`/api/templates/brief/${encodeURIComponent(briefId)}/chat`, { message });
}

export async function generateFromBrief(briefId: string): Promise<{ jobId: string; message?: string }> {
  return post<{ jobId: string; message?: string }>(`/api/templates/brief/${encodeURIComponent(briefId)}/generate`, {});
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

// ---------------------------------------------------------------------------
// Admin — backup, restore, migration
// ---------------------------------------------------------------------------

export async function exportBackup(path?: string): Promise<{ ok: boolean; path: string }> {
  return post("/api/admin/backup", { path });
}

export async function restoreBackup(path: string, overwrite = false): Promise<{ ok: boolean; restored: string[] }> {
  return post("/api/admin/restore", { path, overwrite });
}

export async function runMigration(dryRun = false): Promise<{ ok?: boolean; migrated?: number; dryRun?: boolean }> {
  return post(`/api/admin/migrate?dryRun=${dryRun ? "true" : "false"}`, {});
}

// ---------------------------------------------------------------------------
// Phase 4b: Work-scoped RPA Publishing API
// ---------------------------------------------------------------------------

export interface PublishRecord {
  id: number;
  workId: string;
  platform: string;
  /** 本次发布使用的账号（2026-08-20 数据看板重构，Task 4 起后端记录） */
  accountId?: string;
  status: "pending" | "publishing" | "published" | "failed" | "scheduled" | "fallback";
  platformPostId?: string;
  postUrl?: string;
  error?: string;
  publishedAt?: string;
  scheduledAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublishInput {
  workId: string;
  videoPath: string;
  coverPath?: string;
  title: string;
  options?: Record<string, unknown>;
}

export async function publishWorkToPlatform(
  workId: string,
  platform: string,
  input?: { videoPath?: string; coverPath?: string; title?: string; options?: Record<string, unknown> },
  accountId?: string,
): Promise<PublishRecord> {
  return post<PublishRecord>(
    `/api/works/${encodeURIComponent(workId)}/publish/${encodeURIComponent(platform)}`,
    { ...(input ?? {}), accountId },
  );
}

export async function triggerWorkPublishLogin(workId: string, platform: string): Promise<{ success: boolean }> {
  return post<{ success: boolean }>(`/api/works/${encodeURIComponent(workId)}/publish/${encodeURIComponent(platform)}/login`, {});
}

export async function fetchWorkPublishRecords(workId: string): Promise<PublishRecord[]> {
  const data = await request<{ publishRecords: PublishRecord[] }>(`/api/works/${encodeURIComponent(workId)}/publish/records`);
  return data.publishRecords;
}

export function getWorkPublishFallbackUrl(workId: string, platform: string): string {
  return `/api/works/${encodeURIComponent(workId)}/publish/${encodeURIComponent(platform)}/fallback`;
}

// ---------------------------------------------------------------------------
// Voices（声音克隆 / 配音音色）
// ---------------------------------------------------------------------------

export interface VoiceItem {
  id: string;
  name: string;
  voice_id: string;
  type: "cloned" | "builtin_fav";
  status: "cloning" | "ready" | "failed";
  source_file_path?: string;
  demo_audio_path?: string;
  error?: string;
  metadata: Record<string, unknown>;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface BuiltinVoice {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
}

export async function fetchVoices() {
  return get<{ voices: VoiceItem[] }>("/api/voices");
}

export async function fetchBuiltinVoices() {
  return get<{ voices: BuiltinVoice[]; categories: string[] }>("/api/voices/builtin");
}

export async function cloneVoice(name: string, file: File) {
  const form = new FormData();
  form.append("name", name);
  form.append("file", file);
  return request<VoiceItem>("/api/voices/clone", { method: "POST", body: form });
}

export async function requestVoiceDemo(id: string, text?: string) {
  return post<{ url: string }>(`/api/voices/${encodeURIComponent(id)}/demo`, { text });
}

export async function requestBuiltinDemo(voiceId: string, text?: string) {
  return post<{ url: string }>("/api/voices/builtin-demo", { voiceId, text });
}

export async function favoriteVoice(voiceId: string, name: string, metadata?: Record<string, unknown>) {
  return post<VoiceItem>("/api/voices/favorite", { voiceId, name, metadata });
}

export async function deleteVoice(id: string) {
  return request<{ deleted: boolean }>(`/api/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
}
