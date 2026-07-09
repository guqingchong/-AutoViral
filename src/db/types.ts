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
