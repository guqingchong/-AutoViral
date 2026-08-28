export type DbWorkType = "short-video" | "image-text";
export type DbWorkStatus =
  | "draft"
  | "researching"
  | "planning"
  | "assetting"
  | "assembling"
  | "reviewing"
  | "approved"
  | "published"
  | "failed";
export type DbStepStatus = "pending" | "active" | "evaluating" | "done" | "skipped" | "eval_blocked" | "awaiting_human";

export interface DbWork {
  id: string;
  title: string;
  type: DbWorkType;
  content_category?: string;
  content_form?: string;           // PRD: hot_comment | knowledge | industry | insight
  video_source?: string;
  video_search_query?: string;
  status: DbWorkStatus;
  platforms: string[];
  evaluation_mode: boolean;
  topic_hint?: string;
  topic_id?: number;               // FK → topics.id (PRD: Work → Topic back-reference)
  article_id?: number;             // FK → articles.id
  script_id?: number;              // FK → scripts.id
  digital_human_id?: string;       // column exists since migration v2, type was missing
  voice_id?: string;               // TTS 音色（MiniMax voice_id / 克隆音色 ID），缺省用 provider 默认音色
  cli_session_id?: string;
  account_id?: string;
  eval_session_ids?: Record<string, string>;
  eval_attempts?: Record<string, number>;
  topic_category?: string;
  emotion_type?: string;
  hook_type?: string;
  template_id?: string;
  tags: string[];
  estimated_cost?: number;         // PRD: 预估成本
  actual_cost?: number;            // PRD: 实际成本
  review_comment?: string;         // 发布中心最近一次打回的审核意见
  asset_form?: string;             // 素材形态：video-mix | image-carousel | slides | auto（迁移 v19）
  asset_source?: string;           // 素材来源：stock | ai | user | auto | smart（迁移 v19，smart 为 2026-08-14 精品混合路由）
  asset_budget?: string;           // 成本档：eco（禁 AI 视频生成）| premium（迁移 v19）
  dual_output?: boolean;           // 双产物标记：短视频+图文同一作品双产物（迁移 v19）
  parent_work_id?: string;         // 图文子作品 → 短视频父作品（迁移 v20）
  auto_mode?: boolean;             // 全自动模式：批量按钮创建=true，其余=深度介入（迁移 v23）
  purpose?: string;                // 用途：grow_fans|sell_products|drive_traffic|brand_exposure|authority|short_drama（迁移 v26，04 方案）
  /** 用户显式参数 JSON(迁移 v30,批次5.8):只存用户显式给的键(如 {"duration":300}),缺省键不出现 */
  explicit_params?: string;
  created_at: string;
  updated_at: string;
}

export interface DbPipelineStep {
  work_id: string;
  step_key: string;
  name: string;
  status: DbStepStatus;
  started_at?: string;
  completed_at?: string;
  note?: string;
  sort_order: number;
}

export interface DbTopic {
  id: number;
  work_id?: string;
  snapshot_id?: number;
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
  source_url?: string;
  content_plan?: Record<string, unknown>;
  status: "collected" | "selected" | "converted";
  created_at: string;
}

export interface DbTrendSnapshot {
  id: number;
  platform: string;
  snapshot_date: string;
  raw_data: Record<string, unknown>;
  report_path?: string;
  created_at: string;
}

export interface DbArticle {
  id: number;
  work_id?: string;
  topic_id?: number;
  title: string;
  content: string;
  platform?: string;
  status: "draft" | "ready";
  created_at: string;
  updated_at?: string;
}

export interface DbScript {
  id: number;
  work_id?: string;
  article_id?: number;
  content: Record<string, unknown>;
  duration?: number;
  status: "draft" | "ready";
  created_at: string;
}

export type DbAvatarStatus = "draft" | "training" | "ready" | "failed";
export type DbAvatarSource = "heygem" | "upload";

export interface DbAvatar {
  id: string;
  name: string;
  status: DbAvatarStatus;
  source: DbAvatarSource;
  reference_video_path?: string;
  preview_url?: string;
  provider_avatar_id?: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type DbVoiceType = "cloned" | "builtin_fav";
export type DbVoiceStatus = "cloning" | "ready" | "failed";

export interface DbVoice {
  id: string;                 // 内部 ID（nanoid 风格字符串）
  name: string;
  voice_id: string;           // MiniMax voice_id
  type: DbVoiceType;
  status: DbVoiceStatus;
  source_file_path?: string;
  demo_audio_path?: string;
  error?: string;
  metadata: Record<string, unknown>;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export type DbDigitalHumanJobStatus = "pending" | "queued" | "running" | "done" | "failed";
export type DbDigitalHumanProvider = "heygem";

export interface DbDigitalHumanJob {
  id: string;
  work_id?: string;
  avatar_id: string;
  audio_path: string;
  script_id?: number;
  provider: DbDigitalHumanProvider;
  status: DbDigitalHumanJobStatus;
  progress: number;
  result_url?: string;
  result_local_path?: string;
  error?: string;
  estimated_cost: number;
  actual_cost: number;
  provider_job_id?: string;
  /** 渲染池顺序（= 作品队列 position；不在队列的作品排最后）。迁移 v17 新增，旧数据为 null */
  queue_position?: number | null;
  created_at: string;
  updated_at: string;
}

export type DbAssetType = "image" | "video" | "audio" | "font" | "other";
export type DbAssetCategory = "characters" | "scenes" | "music" | "templates" | "branding" | "general";
export type DbAssetSource = "pexels" | "pixabay" | "unsplash" | "self-generated" | "upload" | "unknown";
export type DbAssetLicense = "cc0" | "commercial" | "unknown" | "needs-review";
export type DbAssetCompliance = "passed" | "failed" | "pending";

export interface DbAsset {
  id: number;
  name: string;
  file_path: string;
  category: DbAssetCategory;
  type: DbAssetType;
  tags: string[];
  source: DbAssetSource;
  license: DbAssetLicense;
  compliance_status: DbAssetCompliance;
  metadata: Record<string, unknown>;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

// ── Account types (Phase 7) ──────────────────────────────────────────────

export type DbAccountStatus = "active" | "inactive";

export interface DbAccount {
  id: string;
  name: string;
  platform: string;
  tone_profile: Record<string, unknown>;
  status: DbAccountStatus;
  username?: string;
  password?: string;
  cookie?: string;
  is_default?: number;             // 平台内默认账号标记(迁移 v29)
  created_at: string;
  updated_at: string;
}

// ── Publish types (Phase 4) ──────────────────────────────────────────────

export type PublishAccountStatus = "active" | "disabled" | "expired";
export type PublishJobStatus =
  | "pending"
  // "compliance_review" and "compliance_failed" are intentionally omitted:
  // compliance failures are detected and blocked at the request level
  // before a job is created, so no job ever enters these states.
  | "publishing"
  | "published"
  | "failed";

export interface DbPublishAccount {
  id: string;
  platform: string;
  display_name: string;
  credentials: Record<string, unknown>; // stored as JSON in DB, serialized by repo
  status: PublishAccountStatus;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ComplianceResult {
  passed: boolean;
  violations: Array<{
    platform: string;
    word: string;
    severity: "low" | "medium" | "high";
    context: string;
  }>;
}

export interface DbPublishJob {
  id: string;
  work_id: string | null;
  render_job_id: string | null;
  account_id: string;
  platform: string;
  title: string;
  content: string;
  media_path: string | null;
  status: PublishJobStatus;
  compliance_result: ComplianceResult;
  error: string | null;
  post_url: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbBannedWord {
  id: number;
  platform: string;
  word: string;
  severity: "low" | "medium" | "high";
  created_at: string;
}

// ── Phase 5: Data Recycling & Self-Evolution ──────────────────────────────

export type DbPublishRecordStatus = "pending" | "publishing" | "reviewing" | "published" | "failed" | "scheduled" | "fallback";

export interface DbPublishRecord {
  id: number;
  work_id: string;
  platform: string;
  account_id?: string;
  platform_post_id?: string;
  status: DbPublishRecordStatus;
  scheduled_at?: string;
  published_at?: string;
  error_message?: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export type DbMetricType = "work" | "account";

export interface DbPlatformMetric {
  id: number;
  publish_record_id?: number;
  platform: string;
  account_id?: string | null;
  metric_type: DbMetricType;
  external_id?: string;
  collected_at: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  collects?: number;
  completion_rate?: number;
  followers?: number;
  raw_data: Record<string, unknown>;
}

export type DbCommentSentiment = "positive" | "negative" | "neutral" | "question";

export interface DbComment {
  id: number;
  publish_record_id: number;
  external_comment_id?: string;
  author_name?: string;
  author_id?: string;
  content: string;
  sentiment?: DbCommentSentiment;
  is_reply: boolean;
  parent_external_id?: string;
  replied: boolean;
  reply_content?: string;
  reply_published_at?: string;
  collected_at: string;
  created_at: string;
}

export type DbRuleType = "topic" | "template" | "prompt" | "publish_time" | "platform";

export interface DbEvolutionRule {
  id: number;
  rule_type: DbRuleType;
  target_key?: string;
  condition_json: Record<string, unknown>;
  action: string;
  confidence: number;
  source: string;
  enabled: boolean;
  applied_count: number;
  created_at: string;
  updated_at: string;
}

export interface DbBaseline {
  id: number;
  metric_name: string;
  platform?: string;
  value_json: Record<string, unknown>;
  sample_count: number;
  computed_at: string;
}

// ── Phase 8: Content Schedule ──────────────────────────────────────────────

export type DbScheduleStatus = "planned" | "in_progress" | "done" | "cancelled";

export interface DbContentSchedule {
  id: string;
  work_id?: string;
  account_id?: string;
  title: string;
  description: string;
  scheduled_date: string;
  scheduled_time?: string;
  platform: string;
  content_type: DbWorkType;
  status: DbScheduleStatus;
  color?: string;
  created_at: string;
  updated_at: string;
}
