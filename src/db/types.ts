export type DbWorkType = "short-video" | "image-text";
export type DbWorkStatus =
  | "draft"
  | "researching"
  | "planning"
  | "assetting"
  | "assembling"
  | "reviewing"
  | "published"
  | "failed";
export type DbStepStatus = "pending" | "active" | "evaluating" | "done" | "skipped" | "eval_blocked";

export interface DbWork {
  id: string;
  title: string;
  type: DbWorkType;
  content_category?: string;
  video_source?: string;
  video_search_query?: string;
  status: DbWorkStatus;
  platforms: string[];
  evaluation_mode: boolean;
  topic_hint?: string;
  cli_session_id?: string;
  eval_session_ids?: Record<string, string>;
  eval_attempts?: Record<string, number>;
  topic_category?: string;
  emotion_type?: string;
  hook_type?: string;
  template_id?: string;
  tags: string[];
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
export type DbAvatarSource = "chanjing" | "bailian" | "upload";

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

export type DbDigitalHumanJobStatus = "pending" | "queued" | "running" | "done" | "failed";
export type DbDigitalHumanProvider = "chanjing" | "bailian";

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
