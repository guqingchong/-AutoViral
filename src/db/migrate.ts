import { randomUUID } from "node:crypto";
import { getDb } from "./connection.js";

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  content_category TEXT,
  video_source TEXT,
  video_search_query TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  platforms TEXT NOT NULL DEFAULT '[]',
  evaluation_mode INTEGER NOT NULL DEFAULT 0,
  topic_hint TEXT,
  cli_session_id TEXT,
  eval_session_ids TEXT DEFAULT '{}',
  eval_attempts TEXT DEFAULT '{}',
  topic_category TEXT,
  emotion_type TEXT,
  hook_type TEXT,
  template_id TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  work_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (work_id, step_key),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS work_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT,
  kind TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trend_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  raw_data TEXT NOT NULL DEFAULT '{}',
  report_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT,
  snapshot_id INTEGER,
  platform TEXT,
  title TEXT NOT NULL,
  description TEXT,
  heat INTEGER,
  competition TEXT,
  opportunity TEXT,
  emotion_type TEXT,
  emotion_subtype TEXT,
  tags TEXT DEFAULT '[]',
  content_angles TEXT DEFAULT '[]',
  example_hook TEXT,
  category TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'collected',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (snapshot_id) REFERENCES trend_snapshots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT,
  topic_id INTEGER,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT,
  article_id INTEGER,
  content TEXT NOT NULL DEFAULT '{}',
  duration INTEGER,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);
CREATE INDEX IF NOT EXISTS idx_topics_platform ON topics(platform);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_platform_date ON trend_snapshots(platform, snapshot_date);
`,
  },
  {
    version: 2,
    name: "digital_human_and_asset_library",
    sql: `
ALTER TABLE works ADD COLUMN digital_human_id TEXT;
ALTER TABLE works ADD COLUMN asset_ids TEXT DEFAULT '[]';

CREATE TABLE IF NOT EXISTS avatars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  source TEXT NOT NULL,
  reference_video_path TEXT,
  preview_url TEXT,
  provider_avatar_id TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digital_human_jobs (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  avatar_id TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  script_id INTEGER,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress INTEGER NOT NULL DEFAULT 0,
  result_url TEXT,
  result_local_path TEXT,
  error TEXT,
  estimated_cost REAL NOT NULL DEFAULT 0,
  actual_cost REAL NOT NULL DEFAULT 0,
  provider_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (avatar_id) REFERENCES avatars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS asset_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'unknown',
  license TEXT NOT NULL DEFAULT 'unknown',
  compliance_status TEXT NOT NULL DEFAULT 'pending',
  metadata TEXT DEFAULT '{}',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_works_digital_human_id ON works(digital_human_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON digital_human_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_work_id ON digital_human_jobs(work_id);
CREATE INDEX IF NOT EXISTS idx_assets_category ON asset_library(category);
CREATE INDEX IF NOT EXISTS idx_assets_compliance ON asset_library(compliance_status);
`,
  },
  {
    version: 3,
    name: "templates_and_render_jobs",
    sql: `
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_form TEXT,
  canvas TEXT NOT NULL DEFAULT '{}',
  variables TEXT NOT NULL DEFAULT '[]',
  layers TEXT NOT NULL DEFAULT '[]',
  audio TEXT NOT NULL DEFAULT '[]',
  subtitles TEXT DEFAULT '{}',
  transitions TEXT DEFAULT '[]',
  preview_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  template_id TEXT,
  output_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0,
  duration REAL,
  current_time REAL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);
CREATE INDEX IF NOT EXISTS idx_templates_content_form ON templates(content_form);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_work ON render_jobs(work_id);
`,
  },
  {
    version: 4,
    name: "publish_and_compliance",
    sql: `
CREATE TABLE IF NOT EXISTS publish_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credentials TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  render_job_id TEXT,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  media_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  compliance_result TEXT NOT NULL DEFAULT '{"passed":true,"violations":[]}',
  error TEXT,
  post_url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (render_job_id) REFERENCES render_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES publish_accounts(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS compliance_banned_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  word TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publish_accounts_platform ON publish_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_publish_accounts_status ON publish_accounts(status);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_work_id ON publish_jobs(work_id);
CREATE INDEX IF NOT EXISTS idx_banned_words_platform ON compliance_banned_words(platform);

INSERT INTO compliance_banned_words (platform, word, severity) VALUES
('all', '色情', 'high'),
('all', '赌博', 'high'),
('all', '毒品', 'high'),
('all', '诈骗', 'high'),
('all', '虚假宣传', 'medium'),
('all', '诱导分享', 'medium'),
('all', '政治敏感', 'high'),
('all', '低俗', 'medium'),
('all', '暴力', 'high'),
('all', '侵权', 'medium'),
('all', '违禁药品', 'high'),
('all', '非法交易', 'high'),
('all', '刷单', 'medium'),
('all', '传销', 'high'),
('all', '恶意营销', 'medium'),
('all', '人身攻击', 'medium'),
('all', '谣言', 'high'),
('all', '歧视', 'high'),
('all', '恐怖', 'high'),
('all', '伪造', 'medium');
`,
  },
  {
    version: 5,
    name: "publish_jobs_render_job_fk",
    sql: `
-- Add FOREIGN KEY on publish_jobs.render_job_id for existing databases.
-- SQLite does not support ALTER TABLE ADD FOREIGN KEY, so we recreate.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS publish_jobs_v5 (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  render_job_id TEXT,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  media_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  compliance_result TEXT NOT NULL DEFAULT '{"passed":true,"violations":[]}',
  error TEXT,
  post_url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL,
  FOREIGN KEY (render_job_id) REFERENCES render_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES publish_accounts(id) ON DELETE RESTRICT
);

INSERT INTO publish_jobs_v5 SELECT * FROM publish_jobs;
DROP TABLE publish_jobs;
ALTER TABLE publish_jobs_v5 RENAME TO publish_jobs;

CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_work_id ON publish_jobs(work_id);

PRAGMA foreign_keys = ON;
`,
  },
  {
    version: 6,
    name: "phase5_analytics_evolution",
    sql: `
-- publish_records: track each publish event for data recycling
CREATE TABLE IF NOT EXISTS publish_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_post_id TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  scheduled_at TEXT,
  published_at TEXT,
  error_message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- eval_results: review scores per work (referenced by hit-failure analysis)
CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL UNIQUE,
  overall_score REAL,
  dimensions TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_record_id INTEGER,
  platform TEXT NOT NULL,
  metric_type TEXT NOT NULL DEFAULT 'work',
  external_id TEXT,
  collected_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  collects INTEGER,
  completion_rate REAL,
  followers INTEGER,
  raw_data TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (publish_record_id) REFERENCES publish_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publish_record_id INTEGER NOT NULL,
  external_comment_id TEXT,
  author_name TEXT,
  author_id TEXT,
  content TEXT NOT NULL,
  sentiment TEXT,
  is_reply INTEGER NOT NULL DEFAULT 0,
  parent_external_id TEXT,
  replied INTEGER NOT NULL DEFAULT 0,
  reply_content TEXT,
  reply_published_at TEXT,
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (publish_record_id) REFERENCES publish_records(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evolution_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL,
  target_key TEXT,
  condition_json TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  applied_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  platform TEXT,
  value_json TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publish_records_work_id ON publish_records(work_id);
CREATE INDEX IF NOT EXISTS idx_publish_records_status ON publish_records(status);
CREATE INDEX IF NOT EXISTS idx_publish_records_platform ON publish_records(platform);
CREATE INDEX IF NOT EXISTS idx_metrics_record ON platform_metrics(publish_record_id);
CREATE INDEX IF NOT EXISTS idx_metrics_platform_collected ON platform_metrics(platform, collected_at);
CREATE INDEX IF NOT EXISTS idx_comments_record ON comments(publish_record_id);
CREATE INDEX IF NOT EXISTS idx_rules_type ON evolution_rules(rule_type, enabled);
CREATE INDEX IF NOT EXISTS idx_baselines_name ON baselines(metric_name, platform);
`,
  },
  {
    version: 7,
    name: "platform_credentials",
    sql: `
CREATE TABLE IF NOT EXISTS platform_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  key_type TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, key_type)
);

CREATE INDEX IF NOT EXISTS idx_platform_credentials_platform ON platform_credentials(platform);
`,
  },
  {
    version: 8,
    name: "account_management",
    sql: `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  tone_profile TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE works ADD COLUMN account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_works_account_id ON works(account_id);
`,
  },
  {
    version: 9,
    name: "content_schedule",
    sql: `
CREATE TABLE IF NOT EXISTS content_schedule (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  account_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT,
  platform TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT 'short-video',
  status TEXT NOT NULL DEFAULT 'planned',
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON content_schedule(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_schedule_work ON content_schedule(work_id);
CREATE INDEX IF NOT EXISTS idx_schedule_account ON content_schedule(account_id);
`,
  },
  {
    version: 10,
    name: "prd_work_fields",
    sql: `
ALTER TABLE works ADD COLUMN topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL;
ALTER TABLE works ADD COLUMN content_form TEXT;
ALTER TABLE works ADD COLUMN article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL;
ALTER TABLE works ADD COLUMN script_id INTEGER REFERENCES scripts(id) ON DELETE SET NULL;
ALTER TABLE works ADD COLUMN estimated_cost REAL DEFAULT 0;
ALTER TABLE works ADD COLUMN actual_cost REAL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_works_topic_id ON works(topic_id);
CREATE INDEX IF NOT EXISTS idx_works_content_form ON works(content_form);
`,
  },
  {
    version: 11,
    name: "topic_contentplan_and_data_sources",
    sql: `
ALTER TABLE topics ADD COLUMN content_plan TEXT;

CREATE TABLE IF NOT EXISTS data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  platform TEXT,
  title TEXT,
  reference_count INTEGER NOT NULL DEFAULT 0,
  fixed INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_referenced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_data_sources_fixed ON data_sources(fixed);
CREATE INDEX IF NOT EXISTS idx_data_sources_url ON data_sources(url);
`,
  },
  {
    version: 12,
    name: "account_credentials_and_template_jobs",
    sql: `
ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN password TEXT;
ALTER TABLE accounts ADD COLUMN cookie TEXT;

CREATE TABLE IF NOT EXISTS template_gen_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  count INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE articles ADD COLUMN updated_at TEXT;
`,
  },
  {
    version: 13,
    name: "work_review_comment",
    sql: `
ALTER TABLE works ADD COLUMN review_comment TEXT;
`,
  },
  {
    version: 14,
    name: "heygem-single-engine",
    sql: `
      UPDATE avatars SET source = 'heygem' WHERE source IN ('chanjing', 'bailian');
      UPDATE digital_human_jobs SET provider = 'heygem' WHERE provider IN ('chanjing', 'bailian');
    `,
  },
  {
    version: 15,
    name: "template-evolution",
    sql: `
-- 模板使用频次（自进化信号：渲染一次 +1，生成时优先参考高频模板要素组合）
ALTER TABLE templates ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;

-- 模板设计技能库：调研学习按钮蒸馏出的全网优秀模板设计经验，生成时注入 prompt
CREATE TABLE IF NOT EXISTS template_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_form TEXT,
  elements TEXT NOT NULL DEFAULT '{}',
  skill TEXT NOT NULL,
  source TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 任务类型区分：generate（模板生成）/ research（调研学习）
ALTER TABLE template_gen_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'generate';
`,
  },
  {
    version: 16,
    name: "voices",
    sql: `
CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cloned',
  status TEXT NOT NULL DEFAULT 'cloning',
  source_file_path TEXT,
  demo_audio_path TEXT,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE works ADD COLUMN voice_id TEXT;

CREATE INDEX IF NOT EXISTS idx_voices_voice_id ON voices(voice_id);
CREATE INDEX IF NOT EXISTS idx_voices_type ON voices(type);
`,
  },
  {
    version: 17,
    name: "work_queue",
    sql: `
CREATE TABLE IF NOT EXISTS work_queue (
  work_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  enqueued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  resume_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_work_queue_status_pos ON work_queue(status, position);
ALTER TABLE digital_human_jobs ADD COLUMN queue_position INTEGER;
`,
  },
  {
    version: 18,
    name: "template_kind",
    sql: `
-- 模板类别：video（默认，视频时间线模板）/ image-text（图文版式模板）
ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';
CREATE INDEX IF NOT EXISTS idx_templates_kind ON templates(kind);
`,
  },
  {
    version: 19,
    name: "works_asset_dimensions",
    sql: `
-- 批量制作素材三维（形态/来源/成本档）与双产物标记（短视频+图文）
ALTER TABLE works ADD COLUMN asset_form TEXT;
ALTER TABLE works ADD COLUMN asset_source TEXT;
ALTER TABLE works ADD COLUMN asset_budget TEXT;
ALTER TABLE works ADD COLUMN dual_output INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 20,
    name: "works_parent_work_id",
    sql: `
-- 双产物派生的图文子作品：parent_work_id 指向短视频父作品
-- （子作品拥有独立的 待审核→待发布→已发布 生命周期，实现视频/图文分块发布）
ALTER TABLE works ADD COLUMN parent_work_id TEXT;
CREATE INDEX IF NOT EXISTS idx_works_parent_work_id ON works(parent_work_id);
`,
  },
  {
    version: 21,
    name: "templates_branding",
    sql: `
-- 模板级品牌 logo(2026-08-13 模板库改造 功能 c):
-- JSON 字符串 {logoAsset, position, margin, width, opacity},
-- 视频渲染(video-factory)与图文卡片(dual-output buildCardHtml)共用
ALTER TABLE templates ADD COLUMN branding TEXT;
`,
  },
  {
    version: 22,
    name: "asset_library_kind_index",
    sql: `
-- C5 素材沉淀复用(2026-08-14):asset_library 表自迁移 v2 已存在,
-- 此处仅补常用检索索引(不改变结构)
CREATE INDEX IF NOT EXISTS idx_asset_library_type ON asset_library(type);
CREATE INDEX IF NOT EXISTS idx_asset_library_source ON asset_library(source);
`,
  },
  {
    version: 23,
    name: "works_auto_mode",
    sql: `
-- 全自动模式显式开关(2026-08-16 用户决策):模式由创建入口决定——
-- 选题页「批量转为作品(自动流水线)」按钮创建的作品 auto_mode=1(无人值守),
-- 其余入口 = 深度介入(逐步确认)。不再用模板/数字人选择推断模式。
ALTER TABLE works ADD COLUMN auto_mode INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 24,
    name: "llm_usage",
    sql: `
-- LLM 直连用量记账(2026-08-18 P3-T2):每次 chatStream 完成落一条,
-- 成本按 config.llm.priceTable(元/百万 tokens)估算;日累计超 budget.dailyLimitYuan 熔断
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  work_id TEXT,
  stage TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cost_yuan REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts);
CREATE INDEX IF NOT EXISTS idx_llm_usage_work ON llm_usage(work_id);
`,
  },
  {
    version: 25,
    name: "topic_scores",
    sql: `
-- B1 数据回流(2026-08-18 P3-T4):发布 48h 后抓三率(完播/点赞/互动),
-- 按 品类×情绪 聚合为选题权重,回流到趋势打分(topicScore)
CREATE TABLE IF NOT EXISTS topic_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT,
  topic_id INTEGER,
  category TEXT,
  emotion_type TEXT,
  views INTEGER,
  completion_rate REAL,
  like_rate REAL,
  interaction_rate REAL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_topic_scores_cat ON topic_scores(category, emotion_type);
CREATE INDEX IF NOT EXISTS idx_topic_scores_work ON topic_scores(work_id);
`,
  },
  {
    version: 26,
    name: "purpose_skills_and_works_purpose",
    sql: `
-- 用途驱动批量制作(2026-08-18 04 方案):用途技能包 + 作品用途标记
-- purpose_skills:按用途沉淀的调研蒸馏技能(钩子公式/结构模板/话术),
-- 随实战三率回流调权,持续进化
CREATE TABLE IF NOT EXISTS purpose_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  skill TEXT NOT NULL,
  source TEXT,
  weight REAL NOT NULL DEFAULT 1.0,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(purpose, skill)
);
CREATE INDEX IF NOT EXISTS idx_purpose_skills_purpose ON purpose_skills(purpose);

ALTER TABLE works ADD COLUMN purpose TEXT;
`,
  },
  {
    version: 27,
    name: "work_queue_paused_reason",
    sql: `
-- 2026-08-19 P0 修复:paused 加原因字段(quota/budget/user)。
-- 此前 paused 有入口无出口:配额/熔断恢复后 paused 项永不回 queued,
-- 而配额试探又不分原因误恢复用户手动暂停项——三态互踩,批量队列静默停摆。
ALTER TABLE work_queue ADD COLUMN paused_reason TEXT;
`,
  },
  {
    version: 28,
    name: "evolution_marks_and_purpose_performance",
    sql: `
-- 2026-08-19 数据闭环补全:
-- evolution_marks:自进化去重(同一发布记录的同一判定只进化一次,
--   此前每 6h 对同一爆款重复生成规则,一周 ~28 条重复且静默烧 LLM 费)
-- purpose_performance:用途×三率聚合因子(三率回流反哺用途技能包权重的落地载体)
CREATE TABLE IF NOT EXISTS evolution_marks (
  record_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(record_id, verdict)
);
CREATE TABLE IF NOT EXISTS purpose_performance (
  purpose TEXT PRIMARY KEY,
  factor REAL NOT NULL DEFAULT 1.0,
  samples INTEGER NOT NULL DEFAULT 0,
  avg_interaction REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  },
  {
    version: 29,
    name: "account_credentials_and_account_dimension",
    sql: `
-- 2026-08-20 数据看板重构(方案A):账号成为一等公民。
-- account_credentials 取代 platform_credentials 成为凭证唯一事实源,
-- 去重键从 (platform, key_type) 降为 (account_id, key_type),支持一平台多账号。
CREATE TABLE IF NOT EXISTS account_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, key_type)
);
CREATE INDEX IF NOT EXISTS idx_account_credentials_account ON account_credentials(account_id);

ALTER TABLE publish_records ADD COLUMN account_id TEXT;
ALTER TABLE platform_metrics ADD COLUMN account_id TEXT;
ALTER TABLE accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topic_scores ADD COLUMN platform TEXT NOT NULL DEFAULT 'all';
CREATE INDEX IF NOT EXISTS idx_publish_records_account ON publish_records(account_id);
`,
  },
  {
    version: 30,
    name: "work_explicit_params",
    sql: `
-- 2026-08-28 批次5.8(v2-M1):用户显式参数结构化存储(JSON)。
-- 此前"用户选 5 分钟"只以 topicHint 字符串形态存活,机器不可读、评审不可见——
-- 这是"用户要 5 分钟被评审砍到 2:17"的结构性根源。只记录用户显式给的键,
-- 缺省键不出现 = 天然区分"显式 vs 默认"。
ALTER TABLE works ADD COLUMN explicit_params TEXT;
`,
  },
];

export function migrate(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM migrations").pluck().all() as number[]
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO migrations (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name
      );
    })();
  }

  backfillV29Accounts();
}

/** v29 数据回填(幂等):旧 platform_credentials → 各平台默认账号的 account_credentials;
 *  publish_records.account_id 回填为该平台默认账号。 */
export function backfillV29Accounts(): void {
  const db = getDb();
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_credentials'").get();
  if (!hasTable) return;

  const platforms = db.prepare("SELECT DISTINCT platform FROM platform_credentials").pluck().all() as string[];
  for (const platform of platforms) {
    // 别名归一:platform_credentials 里 wechat_mp 账号体系的凭证存在 wechat 键下,
    // accounts 查询/占位账号用归一后的 accountPlatform,凭证搬迁仍用原 platform。
    const accountPlatform = platform === "wechat" ? "wechat_mp" : platform;
    // 该平台没有账号 → 建占位账号;有 → 取最早创建的一个
    let account = db.prepare("SELECT id FROM accounts WHERE platform = ? ORDER BY created_at ASC LIMIT 1").get(accountPlatform) as { id: string } | undefined;
    if (!account) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO accounts (id, name, platform, tone_profile, status, created_at, updated_at) VALUES (?, ?, ?, '{}', 'active', ?, ?)")
        .run(id, `默认账号-${accountPlatform}`, accountPlatform, now, now);
      account = { id };
    }
    // 每平台保证恰有一个默认账号 —— 但仅在用户尚未手设默认时指派(2026-08-21 终审 I1:
    // 此前无条件"清 0 再置 1",每次 migrate() 都把用户手设的默认账号翻回最早创建者)
    const hasDefault = db.prepare("SELECT 1 FROM accounts WHERE platform = ? AND is_default = 1 LIMIT 1").get(accountPlatform);
    if (!hasDefault) {
      db.prepare("UPDATE accounts SET is_default = 0 WHERE platform = ?").run(accountPlatform);
      db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(account.id);
    }
    // 凭证搬迁:旧表值不覆盖新表已有值(幂等 + 保护已手工配置的新凭证)
    db.prepare(`
      INSERT INTO account_credentials (account_id, key_type, value, updated_at)
      SELECT ?, key_type, value, updated_at FROM platform_credentials WHERE platform = ?
      ON CONFLICT(account_id, key_type) DO NOTHING
    `).run(account.id, platform);
  }
  // 历史发布记录回填默认账号(只补 NULL)
  db.prepare(`
    UPDATE publish_records SET account_id = (
      SELECT id FROM accounts WHERE accounts.platform = publish_records.platform AND is_default = 1 LIMIT 1
    ) WHERE account_id IS NULL
  `).run();
}
