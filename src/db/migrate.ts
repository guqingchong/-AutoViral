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
