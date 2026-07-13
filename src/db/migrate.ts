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
}
