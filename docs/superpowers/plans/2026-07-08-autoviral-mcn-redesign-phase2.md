# AutoViral MCN Redesign — Phase 2: 数字人中台与合规素材库

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建数字人中台（蝉镜主通道 + 百炼 LivePortrait fallback）与合规素材库，完成 DB 实体、服务、API 路由与前端页面，使作品流水线能够选择数字人形象并生成口播视频，同时集中管理可复用素材。

**Architecture:** 在 Phase 1 的 SQLite 基础上新增 `avatars`、`digital_human_jobs`、`asset_library` 三张表；`src/services/digital-human.ts` 负责主备 Provider 调度与轮询下载；`src/services/asset-library.ts` 负责素材元数据 CRUD 与基于来源/授权规则的合规初筛；API 与前端遵循 Phase 1 的 Hono + Svelte 5 约定，素材文件继续落地 `shared-assets/` 目录，元数据进入数据库。

**Tech Stack:** Node.js 18+, TypeScript 5, Hono, Svelte 5 (Runes), Vite, `better-sqlite3`。

---

## 文件结构（创建/修改）

| 文件 | 职责 |
|------|------|
| `src/db/types.ts` | 新增 `DbAvatar`、`DbDigitalHumanJob`、`DbAsset` 类型 |
| `src/db/migrate.ts` | 新增 migration v2：三张表 + works 扩展字段 |
| `src/db/avatars-repo.ts` | 数字人形象仓库 |
| `src/db/digital-human-jobs-repo.ts` | 数字人合成任务仓库 |
| `src/db/assets-repo.ts` | 合规素材库元数据仓库 |
| `src/config.ts` | 新增 `chanjing`、`bailian` 配置与 env 覆盖 |
| `src/services/chanjing-client.ts` | 蝉镜 Open API 客户端（token、形象、视频合成、查询） |
| `src/services/bailian-client.ts` | 阿里云百炼 LivePortrait 客户端 |
| `src/services/digital-human.ts` | 数字人编排服务：主备切换、轮询、结果下载 |
| `src/services/asset-library.ts` | 素材库 CRUD + 合规检查 |
| `src/server/api.ts` | 新增 `/api/digital-humans/*` 与 `/api/assets/*` 路由 |
| `src/server/index.ts` | 启动时确保 `shared-assets` 目录存在 |
| `web/src/lib/api.ts` | 新增数字人与素材库前端 API 封装 |
| `web/src/lib/i18n.ts` | 新增数字人、素材库相关文案 |
| `web/src/pages/DigitalHumans.svelte` | 数字人管理页面 |
| `web/src/pages/Assets.svelte` | 合规素材库页面 |
| `web/src/App.svelte` | 增加导航入口 |
| `tests/db/avatars-repo.test.ts` | 形象仓库测试 |
| `tests/db/digital-human-jobs-repo.test.ts` | 任务仓库测试 |
| `tests/db/assets-repo.test.ts` | 素材仓库测试 |
| `tests/services/chanjing-client.test.ts` | 蝉镜客户端测试 |
| `tests/services/bailian-client.test.ts` | 百炼客户端测试 |
| `tests/services/digital-human.test.ts` | 编排服务测试 |
| `tests/services/asset-library.test.ts` | 素材库服务测试 |
| `tests/server/api-digital-human.test.ts` | 数字人 API 路由测试 |
| `tests/server/api-assets.test.ts` | 素材库 API 路由测试 |

---

## Task 1: 扩展配置与数据库类型/迁移

**Files:**
- Modify: `src/config.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/migrate.ts`
- Test: `tests/db/migrate.test.ts`

- [ ] **Step 1: 在 `src/config.ts` 中增加数字人配置**

  修改 `src/config.ts`：

  ```ts
  export interface Config {
    port: number;
    model: string;
    jimeng: { accessKey: string; secretKey: string };
    openrouter?: { apiKey: string };
    minimax?: { apiKey: string };
    chanjing?: { appId: string; secretKey: string };
    bailian?: { apiKey: string };
    research: { enabled: boolean; schedule: string; platforms: string[] };
    interests?: string[];
    memory?: { apiKey: string; userId: string; syncEnabled: boolean };
    analytics?: { douyinUrl: string; collectInterval: number; enabled: boolean };
  }
  ```

  在 `loadConfig` 的 `.env overrides` 段落后追加：

  ```ts
    if (process.env.CHANJING_APP_ID) {
      config.chanjing = { ...(config.chanjing ?? { appId: "", secretKey: "" }), appId: process.env.CHANJING_APP_ID };
    }
    if (process.env.CHANJING_SECRET_KEY) {
      config.chanjing = { ...(config.chanjing ?? { appId: "", secretKey: "" }), secretKey: process.env.CHANJING_SECRET_KEY };
    }
    if (process.env.BAILIAN_API_KEY) {
      config.bailian = { apiKey: process.env.BAILIAN_API_KEY };
    }
  ```

- [ ] **Step 2: 在 `src/db/types.ts` 中新增实体类型**

  在文件末尾追加：

  ```ts
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
  ```

- [ ] **Step 3: 在 `src/db/migrate.ts` 中新增 migration v2**

  在 `MIGRATIONS` 数组末尾追加：

  ```ts
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
  ```

- [ ] **Step 4: 编写迁移测试**

  创建 `tests/db/migrate.test.ts`（如 Phase 1 已存在则替换为扩展版）：

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";

  describe("migrate", () => {
    beforeEach(() => resetInMemoryDb());
    afterEach(() => closeDb());

    it("creates phase 2 tables", () => {
      migrate();
      const db = resetInMemoryDb();
      migrate();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .pluck()
        .all() as string[];
      expect(tables).toContain("avatars");
      expect(tables).toContain("digital_human_jobs");
      expect(tables).toContain("asset_library");
    });

    it("records applied migrations", () => {
      migrate();
      const db = resetInMemoryDb();
      migrate();
      const rows = db.prepare("SELECT version FROM migrations").all() as { version: number }[];
      const versions = rows.map((r) => r.version);
      expect(versions).toContain(1);
      expect(versions).toContain(2);
    });
  });
  ```

- [ ] **Step 5: 运行测试**

  Run: `npx vitest run tests/db/migrate.test.ts`

  Expected: PASS.

- [ ] **Step 6: 提交**

  ```bash
  git add src/config.ts src/db/types.ts src/db/migrate.ts tests/db/migrate.test.ts
  git commit -m "feat(db): add digital human and asset library schema (migration v2)"
  ```

---

## Task 2: 数字人形象仓库

**Files:**
- Create: `src/db/avatars-repo.ts`
- Test: `tests/db/avatars-repo.test.ts`

- [ ] **Step 1: 实现 `src/db/avatars-repo.ts`**

  ```ts
  import { getDb } from "./connection.js";
  import { fromJson, toJson } from "./json.js";
  import type { DbAvatar } from "./types.js";

  function rowToAvatar(row: Record<string, unknown>): DbAvatar {
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as DbAvatar["status"],
      source: row.source as DbAvatar["source"],
      reference_video_path: (row.reference_video_path as string) || undefined,
      preview_url: (row.preview_url as string) || undefined,
      provider_avatar_id: (row.provider_avatar_id as string) || undefined,
      config: fromJson(row.config as string),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  export function createAvatar(avatar: DbAvatar): DbAvatar {
    const db = getDb();
    db.prepare(
      `INSERT INTO avatars (id, name, status, source, reference_video_path, preview_url, provider_avatar_id, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      avatar.id,
      avatar.name,
      avatar.status,
      avatar.source,
      avatar.reference_video_path ?? null,
      avatar.preview_url ?? null,
      avatar.provider_avatar_id ?? null,
      toJson(avatar.config),
      avatar.created_at,
      avatar.updated_at
    );
    return avatar;
  }

  export function getAvatar(id: string): DbAvatar | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM avatars WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAvatar(row) : undefined;
  }

  export function listAvatars(): DbAvatar[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM avatars ORDER BY updated_at DESC").all() as Record<string, unknown>[];
    return rows.map(rowToAvatar);
  }

  export function updateAvatar(id: string, updates: Partial<DbAvatar>): DbAvatar | undefined {
    const db = getDb();
    const existing = getAvatar(id);
    if (!existing) return undefined;
    const avatar = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE avatars SET name = ?, status = ?, source = ?, reference_video_path = ?, preview_url = ?, provider_avatar_id = ?, config = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      avatar.name,
      avatar.status,
      avatar.source,
      avatar.reference_video_path ?? null,
      avatar.preview_url ?? null,
      avatar.provider_avatar_id ?? null,
      toJson(avatar.config),
      avatar.updated_at,
      id
    );
    return avatar;
  }

  export function deleteAvatar(id: string): boolean {
    const db = getDb();
    const result = db.prepare("DELETE FROM avatars WHERE id = ?").run(id);
    return result.changes > 0;
  }
  ```

- [ ] **Step 2: 编写测试 `tests/db/avatars-repo.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import { createAvatar, getAvatar, listAvatars, updateAvatar, deleteAvatar } from "../../src/db/avatars-repo.js";

  function makeAvatar(overrides: Partial<import("../../src/db/types.js").DbAvatar> = {}): import("../../src/db/types.js").DbAvatar {
    return {
      id: "avatar_test_001",
      name: "Test Avatar",
      status: "ready",
      source: "chanjing",
      provider_avatar_id: "cj_123",
      config: { pitch: 1 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("avatars-repo", () => {
    beforeEach(() => { resetInMemoryDb(); migrate(); });
    afterEach(() => closeDb());

    it("creates and retrieves an avatar", () => {
      createAvatar(makeAvatar());
      const found = getAvatar("avatar_test_001");
      expect(found?.name).toBe("Test Avatar");
      expect(found?.config).toEqual({ pitch: 1 });
    });

    it("lists avatars by updated_at desc", () => {
      createAvatar(makeAvatar({ id: "a1", name: "A", updated_at: "2026-01-01T00:00:00Z" }));
      createAvatar(makeAvatar({ id: "a2", name: "B", updated_at: "2026-01-02T00:00:00Z" }));
      expect(listAvatars()[0].id).toBe("a2");
    });

    it("updates and deletes an avatar", () => {
      createAvatar(makeAvatar());
      updateAvatar("avatar_test_001", { status: "failed" });
      expect(getAvatar("avatar_test_001")?.status).toBe("failed");
      expect(deleteAvatar("avatar_test_001")).toBe(true);
      expect(getAvatar("avatar_test_001")).toBeUndefined();
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/db/avatars-repo.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/db/avatars-repo.ts tests/db/avatars-repo.test.ts
  git commit -m "feat(db): add avatar repository"
  ```

---

## Task 3: 数字人合成任务仓库

**Files:**
- Create: `src/db/digital-human-jobs-repo.ts`
- Test: `tests/db/digital-human-jobs-repo.test.ts`

- [ ] **Step 1: 实现 `src/db/digital-human-jobs-repo.ts`**

  ```ts
  import { getDb } from "./connection.js";
  import type { DbDigitalHumanJob } from "./types.js";

  function rowToJob(row: Record<string, unknown>): DbDigitalHumanJob {
    return {
      id: row.id as string,
      work_id: (row.work_id as string) || undefined,
      avatar_id: row.avatar_id as string,
      audio_path: row.audio_path as string,
      script_id: (row.script_id as number) || undefined,
      provider: row.provider as DbDigitalHumanJob["provider"],
      status: row.status as DbDigitalHumanJob["status"],
      progress: (row.progress as number) ?? 0,
      result_url: (row.result_url as string) || undefined,
      result_local_path: (row.result_local_path as string) || undefined,
      error: (row.error as string) || undefined,
      estimated_cost: (row.estimated_cost as number) ?? 0,
      actual_cost: (row.actual_cost as number) ?? 0,
      provider_job_id: (row.provider_job_id as string) || undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  export function createJob(job: DbDigitalHumanJob): DbDigitalHumanJob {
    const db = getDb();
    db.prepare(
      `INSERT INTO digital_human_jobs (id, work_id, avatar_id, audio_path, script_id, provider, status, progress, result_url, result_local_path, error, estimated_cost, actual_cost, provider_job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id,
      job.work_id ?? null,
      job.avatar_id,
      job.audio_path,
      job.script_id ?? null,
      job.provider,
      job.status,
      job.progress,
      job.result_url ?? null,
      job.result_local_path ?? null,
      job.error ?? null,
      job.estimated_cost,
      job.actual_cost,
      job.provider_job_id ?? null,
      job.created_at,
      job.updated_at
    );
    return job;
  }

  export function getJob(id: string): DbDigitalHumanJob | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM digital_human_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : undefined;
  }

  export function listJobs(workId?: string): DbDigitalHumanJob[] {
    const db = getDb();
    const sql = workId ? "SELECT * FROM digital_human_jobs WHERE work_id = ? ORDER BY created_at DESC" : "SELECT * FROM digital_human_jobs ORDER BY created_at DESC";
    const rows = workId
      ? (db.prepare(sql).all(workId) as Record<string, unknown>[])
      : (db.prepare(sql).all() as Record<string, unknown>[]);
    return rows.map(rowToJob);
  }

  export function updateJob(id: string, updates: Partial<DbDigitalHumanJob>): DbDigitalHumanJob | undefined {
    const db = getDb();
    const existing = getJob(id);
    if (!existing) return undefined;
    const job = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE digital_human_jobs SET work_id = ?, avatar_id = ?, audio_path = ?, script_id = ?, provider = ?, status = ?, progress = ?, result_url = ?, result_local_path = ?, error = ?, estimated_cost = ?, actual_cost = ?, provider_job_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      job.work_id ?? null,
      job.avatar_id,
      job.audio_path,
      job.script_id ?? null,
      job.provider,
      job.status,
      job.progress,
      job.result_url ?? null,
      job.result_local_path ?? null,
      job.error ?? null,
      job.estimated_cost,
      job.actual_cost,
      job.provider_job_id ?? null,
      job.updated_at,
      id
    );
    return job;
  }

  export function deleteJob(id: string): boolean {
    const db = getDb();
    return db.prepare("DELETE FROM digital_human_jobs WHERE id = ?").run(id).changes > 0;
  }
  ```

- [ ] **Step 2: 编写测试 `tests/db/digital-human-jobs-repo.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import { createAvatar } from "../../src/db/avatars-repo.js";
  import { createJob, getJob, listJobs, updateJob } from "../../src/db/digital-human-jobs-repo.js";

  describe("digital-human-jobs-repo", () => {
    beforeEach(() => { resetInMemoryDb(); migrate(); });
    afterEach(() => closeDb());

    it("creates and retrieves a job", () => {
      createAvatar({ id: "av1", name: "A", status: "ready", source: "chanjing", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      createJob({ id: "job1", avatar_id: "av1", audio_path: "/audio.mp3", provider: "chanjing", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      expect(getJob("job1")?.avatar_id).toBe("av1");
    });

    it("filters jobs by work_id", () => {
      createAvatar({ id: "av1", name: "A", status: "ready", source: "chanjing", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      createJob({ id: "j1", work_id: "w1", avatar_id: "av1", audio_path: "/a.mp3", provider: "chanjing", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      createJob({ id: "j2", work_id: "w2", avatar_id: "av1", audio_path: "/b.mp3", provider: "chanjing", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      expect(listJobs("w1").length).toBe(1);
      expect(listJobs("w1")[0].id).toBe("j1");
    });

    it("updates job status", () => {
      createAvatar({ id: "av1", name: "A", status: "ready", source: "chanjing", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      createJob({ id: "j1", avatar_id: "av1", audio_path: "/a.mp3", provider: "chanjing", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
      updateJob("j1", { status: "running", progress: 50 });
      expect(getJob("j1")?.progress).toBe(50);
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/db/digital-human-jobs-repo.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/db/digital-human-jobs-repo.ts tests/db/digital-human-jobs-repo.test.ts
  git commit -m "feat(db): add digital human job repository"
  ```

---

## Task 4: 合规素材库元数据仓库

**Files:**
- Create: `src/db/assets-repo.ts`
- Test: `tests/db/assets-repo.test.ts`

- [ ] **Step 1: 实现 `src/db/assets-repo.ts`**

  ```ts
  import { getDb } from "./connection.js";
  import { fromJson, toJson } from "./json.js";
  import type { DbAsset } from "./types.js";

  function rowToAsset(row: Record<string, unknown>): DbAsset {
    return {
      id: row.id as number,
      name: row.name as string,
      file_path: row.file_path as string,
      category: row.category as DbAsset["category"],
      type: row.type as DbAsset["type"],
      tags: fromJson(row.tags as string),
      source: row.source as DbAsset["source"],
      license: row.license as DbAsset["license"],
      compliance_status: row.compliance_status as DbAsset["compliance_status"],
      metadata: fromJson(row.metadata as string),
      usage_count: (row.usage_count as number) ?? 0,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  export function createAsset(asset: Omit<DbAsset, "id" | "created_at" | "updated_at">): DbAsset {
    const db = getDb();
    const now = new Date().toISOString();
    const result = db.prepare(
      `INSERT INTO asset_library (name, file_path, category, type, tags, source, license, compliance_status, metadata, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      asset.name,
      asset.file_path,
      asset.category,
      asset.type,
      toJson(asset.tags),
      asset.source,
      asset.license,
      asset.compliance_status,
      toJson(asset.metadata),
      asset.usage_count,
      now,
      now
    );
    return { ...asset, id: Number(result.lastInsertRowid), created_at: now, updated_at: now };
  }

  export function getAsset(id: number): DbAsset | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM asset_library WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  export function listAssets(filters?: { category?: string; type?: string; compliance?: string; tag?: string; limit?: number }): DbAsset[] {
    const db = getDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filters?.category) { conditions.push("category = ?"); params.push(filters.category); }
    if (filters?.type) { conditions.push("type = ?"); params.push(filters.type); }
    if (filters?.compliance) { conditions.push("compliance_status = ?"); params.push(filters.compliance); }
    if (filters?.tag) { conditions.push("tags LIKE ?"); params.push(`%"${filters.tag}"%`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filters?.limit ?? 200, 1000);
    const sql = `SELECT * FROM asset_library ${where} ORDER BY updated_at DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToAsset);
  }

  export function updateAsset(id: number, updates: Partial<DbAsset>): DbAsset | undefined {
    const db = getDb();
    const existing = getAsset(id);
    if (!existing) return undefined;
    const asset = { ...existing, ...updates, id, updated_at: new Date().toISOString() };
    db.prepare(
      `UPDATE asset_library SET name = ?, file_path = ?, category = ?, type = ?, tags = ?, source = ?, license = ?, compliance_status = ?, metadata = ?, usage_count = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      asset.name,
      asset.file_path,
      asset.category,
      asset.type,
      toJson(asset.tags),
      asset.source,
      asset.license,
      asset.compliance_status,
      toJson(asset.metadata),
      asset.usage_count,
      asset.updated_at,
      id
    );
    return asset;
  }

  export function deleteAsset(id: number): boolean {
    const db = getDb();
    return db.prepare("DELETE FROM asset_library WHERE id = ?").run(id).changes > 0;
  }

  export function incrementUsageCount(id: number): void {
    const db = getDb();
    db.prepare("UPDATE asset_library SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }
  ```

- [ ] **Step 2: 编写测试 `tests/db/assets-repo.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import { createAsset, getAsset, listAssets, updateAsset, deleteAsset } from "../../src/db/assets-repo.js";

  function makeAsset(overrides: Partial<import("../../src/db/types.js").DbAsset> = {}): Omit<import("../../src/db/types.js").DbAsset, "id" | "created_at" | "updated_at"> {
    return {
      name: "bgm.mp3",
      file_path: "music/bgm.mp3",
      category: "music",
      type: "audio",
      tags: ["happy"],
      source: "upload",
      license: "needs-review",
      compliance_status: "pending",
      metadata: { duration: 120 },
      usage_count: 0,
      ...overrides,
    };
  }

  describe("assets-repo", () => {
    beforeEach(() => { resetInMemoryDb(); migrate(); });
    afterEach(() => closeDb());

    it("creates and filters assets", () => {
      createAsset(makeAsset({ name: "a.mp3", category: "music", type: "audio", tags: ["calm"] }));
      createAsset(makeAsset({ name: "b.png", category: "scenes", type: "image", tags: ["city"] }));
      expect(listAssets({ category: "music" }).length).toBe(1);
      expect(listAssets({ tag: "city" })[0].name).toBe("b.png");
    });

    it("updates and deletes asset", () => {
      const a = createAsset(makeAsset());
      updateAsset(a.id, { license: "cc0", compliance_status: "passed" });
      expect(getAsset(a.id)?.compliance_status).toBe("passed");
      expect(deleteAsset(a.id)).toBe(true);
      expect(getAsset(a.id)).toBeUndefined();
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/db/assets-repo.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/db/assets-repo.ts tests/db/assets-repo.test.ts
  git commit -m "feat(db): add asset library repository"
  ```

---

## Task 5: 蝉镜 Open API 客户端

**Files:**
- Create: `src/services/chanjing-client.ts`
- Test: `tests/services/chanjing-client.test.ts`

- [ ] **Step 1: 实现 `src/services/chanjing-client.ts`**

  ```ts
  import { loadConfig } from "../config.js";

  const BASE_URL = "https://open-api.chanjing.cc";

  interface TokenResponse {
    access_token: string;
    expires_in?: number;
  }

  export interface ChanjingAvatar {
    id: string;
    name: string;
    previewUrl?: string;
  }

  export interface ChanjingSubmitResult {
    jobId: string;
  }

  export interface ChanjingJobResult {
    status: "pending" | "processing" | "success" | "failed";
    progress: number;
    videoUrl?: string;
    error?: string;
  }

  export class ChanjingClient {
    private token: string | null = null;
    private tokenExpiresAt = 0;

    private async ensureCredentials(): Promise<{ appId: string; secretKey: string }> {
      const config = await loadConfig();
      const appId = config.chanjing?.appId ?? process.env.CHANJING_APP_ID;
      const secretKey = config.chanjing?.secretKey ?? process.env.CHANJING_SECRET_KEY;
      if (!appId || !secretKey) throw new Error("Missing ChanJing appId or secretKey");
      return { appId, secretKey };
    }

    async getAccessToken(): Promise<string> {
      if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
      const { appId, secretKey } = await this.ensureCredentials();
      const url = `${BASE_URL}/openapi/v1/token?appid=${encodeURIComponent(appId)}&secretKey=${encodeURIComponent(secretKey)}`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`ChanJing token error: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as TokenResponse;
      this.token = data.access_token;
      this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
      return this.token;
    }

    private async request(path: string, init?: RequestInit): Promise<unknown> {
      const token = await this.getAccessToken();
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`ChanJing API ${path} error: ${res.status} ${text}`);
      try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    async listAvatars(): Promise<ChanjingAvatar[]> {
      const data = (await this.request("/openapi/v1/avatar/list")) as {
        data?: { avatars?: Array<{ avatar_id: string; name: string; preview_url?: string }> };
      };
      const list = data.data?.avatars ?? [];
      return list.map((a) => ({ id: a.avatar_id, name: a.name, previewUrl: a.preview_url }));
    }

    async createAvatar(params: { name: string; videoUrl: string }): Promise<{ avatarId: string; status: string }> {
      const data = (await this.request("/openapi/v1/avatar/create", {
        method: "POST",
        body: JSON.stringify({ name: params.name, video_url: params.videoUrl }),
      })) as { data?: { avatar_id: string; status?: string } };
      const avatarId = data.data?.avatar_id;
      if (!avatarId) throw new Error("ChanJing avatar/create did not return avatar_id");
      return { avatarId, status: data.data?.status ?? "training" };
    }

    async submitVideo(avatarId: string, audioUrl: string, payload?: { text?: string; backgroundUrl?: string }): Promise<ChanjingSubmitResult> {
      const body = { avatar_id: avatarId, audio_url: audioUrl, ...payload };
      const data = (await this.request("/openapi/v1/video/create", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { data?: { job_id: string } };
      const jobId = data.data?.job_id;
      if (!jobId) throw new Error("ChanJing video/create did not return job_id");
      return { jobId };
    }

    async queryVideo(jobId: string): Promise<ChanjingJobResult> {
      const data = (await this.request(`/openapi/v1/video/result?job_id=${encodeURIComponent(jobId)}`)) as {
        data?: { status: number | string; progress?: number; video_url?: string; error_msg?: string };
      };
      const d = data.data ?? {};
      const statusCode = typeof d.status === "number" ? d.status : Number(d.status);
      let status: ChanjingJobResult["status"] = "pending";
      if (statusCode === 2) status = "processing";
      else if (statusCode === 3) status = "success";
      else if (statusCode >= 4) status = "failed";
      return {
        status,
        progress: d.progress ?? (status === "success" ? 100 : status === "processing" ? 50 : 0),
        videoUrl: d.video_url,
        error: d.error_msg,
      };
    }
  }
  ```

- [ ] **Step 2: 编写测试 `tests/services/chanjing-client.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";
  import { ChanjingClient } from "../../src/services/chanjing-client.js";
  import * as configModule from "../../src/config.js";

  describe("chanjing-client", () => {
    beforeEach(() => {
      vi.spyOn(configModule, "loadConfig").mockResolvedValue({
        port: 3271,
        model: "sonnet",
        jimeng: { accessKey: "", secretKey: "" },
        research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
        chanjing: { appId: "app", secretKey: "secret" },
      } as any);
      vi.stubGlobal("fetch", vi.fn());
    });

    it("fetches token and lists avatars", async () => {
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok", expires_in: 7200 }) } as any);
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { avatars: [{ avatar_id: "av1", name: "Avatar 1" }] } }) } as any);
      const client = new ChanjingClient();
      const avatars = await client.listAvatars();
      expect(avatars[0].id).toBe("av1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("submits and queries a video job", async () => {
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) } as any);
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { job_id: "job1" } }) } as any);
      const client = new ChanjingClient();
      const submit = await client.submitVideo("av1", "https://example.com/audio.mp3");
      expect(submit.jobId).toBe("job1");
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/services/chanjing-client.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/services/chanjing-client.ts tests/services/chanjing-client.test.ts
  git commit -m "feat(dh): add ChanJing API client"
  ```

---

## Task 6: 百炼 LivePortrait fallback 客户端

**Files:**
- Create: `src/services/bailian-client.ts`
- Test: `tests/services/bailian-client.test.ts`

- [ ] **Step 1: 实现 `src/services/bailian-client.ts`**

  ```ts
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
  ```

- [ ] **Step 2: 编写测试 `tests/services/bailian-client.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";
  import { BailianClient } from "../../src/services/bailian-client.js";
  import * as configModule from "../../src/config.js";

  describe("bailian-client", () => {
    beforeEach(() => {
      vi.spyOn(configModule, "loadConfig").mockResolvedValue({
        port: 3271,
        model: "sonnet",
        jimeng: { accessKey: "", secretKey: "" },
        research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
        bailian: { apiKey: "key" },
      } as any);
      vi.stubGlobal("fetch", vi.fn());
    });

    it("submits video and queries task", async () => {
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_id: "t1" } }) } as any);
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ output: { task_status: "SUCCEEDED", video_url: "https://v.mp4" } }) } as any);
      const client = new BailianClient();
      const taskId = await client.submitVideo("https://img.jpg", "https://audio.mp3");
      expect(taskId).toBe("t1");
      const result = await client.queryVideo(taskId);
      expect(result.videoUrl).toBe("https://v.mp4");
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/services/bailian-client.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/services/bailian-client.ts tests/services/bailian-client.test.ts
  git commit -m "feat(dh): add Bailian LivePortrait fallback client"
  ```

---

## Task 7: 数字人编排服务

**Files:**
- Create: `src/services/digital-human.ts`
- Test: `tests/services/digital-human.test.ts`

- [ ] **Step 1: 实现 `src/services/digital-human.ts`**

  ```ts
  import { mkdir, writeFile, rm } from "node:fs/promises";
  import { join, extname } from "node:path";
  import { execFile } from "node:child_process";
  import { promisify } from "node:util";
  import { dataDir, loadConfig } from "../config.js";
  import { ChanjingClient } from "./chanjing-client.js";
  import { BailianClient } from "./bailian-client.js";
  import * as avatarsRepo from "../db/avatars-repo.js";
  import * as jobsRepo from "../db/digital-human-jobs-repo.js";
  import type { DbAvatar, DbDigitalHumanJob } from "../db/types.js";

  const execFileAsync = promisify(execFile);

  function generateId(prefix: string): string {
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const hex = Math.random().toString(16).slice(2, 5);
    return `${prefix}_${ts}_${hex}`;
  }

  function now(): string { return new Date().toISOString(); }

  async function resolveMediaUrl(pathOrUrl: string): Promise<string> {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const config = await loadConfig();
    const base = `http://127.0.0.1:${config.port}`;
    if (pathOrUrl.startsWith("/")) return `${base}${pathOrUrl}`;
    return `${base}/${pathOrUrl}`;
  }

  function avatarDir(id: string): string { return join(dataDir, "avatars", id); }
  function avatarMediaPath(id: string, filename: string): string { return join(avatarDir(id), filename); }
  function avatarFramePath(id: string): string { return join(avatarDir(id), "frame.jpg"); }
  function jobOutputDir(id: string): string { return join(dataDir, "digital-human-jobs", id); }
  function jobOutputPath(id: string): string { return join(jobOutputDir(id), "output.mp4"); }

  function publicAvatarMediaUrl(avatarId: string, filename: string): string {
    return `/api/digital-humans/avatars/${encodeURIComponent(avatarId)}/media/${encodeURIComponent(filename)}`;
  }
  function publicAvatarFrameUrl(avatarId: string): string {
    return `/api/digital-humans/avatars/${encodeURIComponent(avatarId)}/frame`;
  }

  export async function createAvatarFromUpload(name: string, data: Buffer, filename: string): Promise<DbAvatar> {
    const id = generateId("avatar");
    await mkdir(avatarDir(id), { recursive: true });
    const ext = extname(filename).toLowerCase() || ".bin";
    const safeName = `media${ext}`;
    const mediaPath = avatarMediaPath(id, safeName);
    await writeFile(mediaPath, data);
    const isVideo = [".mp4", ".mov", ".webm", ".avi"].includes(ext);
    const previewUrl = await resolveMediaUrl(publicAvatarMediaUrl(id, safeName));
    const avatar: DbAvatar = {
      id, name,
      status: isVideo ? "training" : "ready",
      source: isVideo ? "chanjing" : "bailian",
      reference_video_path: mediaPath,
      preview_url: previewUrl,
      config: { originalName: filename, mediaName: safeName },
      created_at: now(),
      updated_at: now(),
    };
    avatarsRepo.createAvatar(avatar);
    if (isVideo) {
      trainAvatarWithChanjing(id).catch((err) => {
        console.error(`[digital-human] avatar training failed ${id}:`, err);
        avatarsRepo.updateAvatar(id, { status: "failed", config: { ...avatar.config, trainingError: (err as Error).message } });
      });
    }
    return avatar;
  }

  export async function importAvatar(name: string, providerAvatarId: string): Promise<DbAvatar> {
    const avatar: DbAvatar = {
      id: generateId("avatar"), name, status: "ready", source: "chanjing",
      provider_avatar_id: providerAvatarId, config: {}, created_at: now(), updated_at: now(),
    };
    avatarsRepo.createAvatar(avatar);
    return avatar;
  }

  async function trainAvatarWithChanjing(avatarId: string): Promise<void> {
    const avatar = avatarsRepo.getAvatar(avatarId);
    if (!avatar || !avatar.reference_video_path) throw new Error("Avatar or reference video not found");
    const mediaName = (avatar.config.mediaName as string) ?? "media.mp4";
    const videoUrl = await resolveMediaUrl(publicAvatarMediaUrl(avatarId, mediaName));
    const client = new ChanjingClient();
    const result = await client.createAvatar({ name: avatar.name, videoUrl });
    avatarsRepo.updateAvatar(avatarId, {
      provider_avatar_id: result.avatarId,
      status: result.status === "ready" ? "ready" : "training",
      preview_url: result.previewUrl ?? avatar.preview_url,
    });
  }

  export async function extractFirstFrame(videoPath: string, outPath: string): Promise<void> {
    await execFileAsync("ffmpeg", ["-y", "-i", videoPath, "-ss", "00:00:00.100", "-vframes", "1", outPath], { timeout: 30000 });
  }

  export async function setDefaultAvatar(avatarId: string): Promise<DbAvatar | undefined> {
    for (const a of avatarsRepo.listAvatars()) {
      if (a.config.isDefault) avatarsRepo.updateAvatar(a.id, { config: { ...a.config, isDefault: false } });
    }
    const existing = avatarsRepo.getAvatar(avatarId);
    if (!existing) return undefined;
    return avatarsRepo.updateAvatar(avatarId, { config: { ...existing.config, isDefault: true } });
  }

  export async function submitJob(input: {
    workId?: string;
    avatarId: string;
    audioUrl: string;
    scriptId?: number;
    estimatedCost?: number;
    fallbackOnFailure?: boolean;
  }): Promise<DbDigitalHumanJob> {
    const avatar = avatarsRepo.getAvatar(input.avatarId);
    if (!avatar) throw new Error("Avatar not found");
    const job: DbDigitalHumanJob = {
      id: generateId("dhjob"),
      work_id: input.workId,
      avatar_id: input.avatarId,
      audio_path: input.audioUrl,
      script_id: input.scriptId,
      provider: "chanjing",
      status: "pending",
      progress: 0,
      estimated_cost: input.estimatedCost ?? 0,
      actual_cost: 0,
      created_at: now(),
      updated_at: now(),
    };
    jobsRepo.createJob(job);
    dispatchJob(job.id, input.fallbackOnFailure ?? true).catch((err) => {
      console.error(`[digital-human] dispatch error ${job.id}:`, err);
      jobsRepo.updateJob(job.id, { status: "failed", error: (err as Error).message });
    });
    return job;
  }

  async function dispatchJob(jobId: string, allowFallback: boolean): Promise<void> {
    const job = jobsRepo.getJob(jobId);
    if (!job) throw new Error("Job not found");
    const avatar = avatarsRepo.getAvatar(job.avatar_id);
    if (!avatar) throw new Error("Avatar not found");
    jobsRepo.updateJob(jobId, { status: "queued", progress: 10 });
    try {
      if (avatar.source === "chanjing" && avatar.provider_avatar_id) {
        const client = new ChanjingClient();
        const audioUrl = await resolveMediaUrl(job.audio_path);
        const submit = await client.submitVideo(avatar.provider_avatar_id, audioUrl);
        jobsRepo.updateJob(jobId, { provider_job_id: submit.jobId, status: "running", progress: 20 });
        return;
      }
    } catch (err) {
      if (!allowFallback) throw err;
      console.warn(`[digital-human] ChanJing failed for ${jobId}, trying Bailian fallback:`, (err as Error).message);
    }
    await dispatchBailian(job, avatar);
  }

  async function dispatchBailian(job: DbDigitalHumanJob, avatar: DbAvatar): Promise<void> {
    let imageUrl = avatar.preview_url;
    if (!imageUrl && avatar.reference_video_path) {
      const framePath = avatarFramePath(avatar.id);
      await extractFirstFrame(avatar.reference_video_path, framePath);
      imageUrl = await resolveMediaUrl(publicAvatarFrameUrl(avatar.id));
    }
    if (!imageUrl) throw new Error("No image source available for Bailian fallback");
    const client = new BailianClient();
    const audioUrl = await resolveMediaUrl(job.audio_path);
    const taskId = await client.submitVideo(imageUrl, audioUrl);
    jobsRepo.updateJob(job.id, { provider: "bailian", provider_job_id: taskId, status: "running", progress: 20 });
  }

  export async function refreshJob(jobId: string): Promise<DbDigitalHumanJob | undefined> {
    const job = jobsRepo.getJob(jobId);
    if (!job || !job.provider_job_id) return job;
    if (job.status === "done" || job.status === "failed") return job;
    try {
      if (job.provider === "chanjing") {
        const client = new ChanjingClient();
        const result = await client.queryVideo(job.provider_job_id);
        if (result.status === "success") return await finalizeJob(job, result.videoUrl);
        if (result.status === "failed") return jobsRepo.updateJob(jobId, { status: "failed", error: result.error ?? "ChanJing job failed", progress: result.progress });
        return jobsRepo.updateJob(jobId, { status: "running", progress: result.progress });
      } else {
        const client = new BailianClient();
        const result = await client.queryVideo(job.provider_job_id);
        if (result.status === "SUCCEEDED") return await finalizeJob(job, result.videoUrl);
        if (result.status === "FAILED") return jobsRepo.updateJob(jobId, { status: "failed", error: result.error ?? "Bailian job failed", progress: result.progress });
        return jobsRepo.updateJob(jobId, { status: "running", progress: result.progress });
      }
    } catch (err) {
      return jobsRepo.updateJob(jobId, { status: "failed", error: (err as Error).message });
    }
  }

  async function finalizeJob(job: DbDigitalHumanJob, videoUrl?: string): Promise<DbDigitalHumanJob | undefined> {
    if (!videoUrl) throw new Error("Provider returned success without video URL");
    const dir = jobOutputDir(job.id);
    await mkdir(dir, { recursive: true });
    const dest = jobOutputPath(job.id);
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Failed to download result: ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return jobsRepo.updateJob(job.id, {
      status: "done",
      progress: 100,
      result_url: videoUrl,
      result_local_path: dest,
      actual_cost: job.estimated_cost,
    });
  }

  export async function pollJob(jobId: string, intervalMs = 5000, timeoutMs = 600_000): Promise<DbDigitalHumanJob | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await refreshJob(jobId);
      if (job?.status === "done" || job?.status === "failed") return job;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return jobsRepo.updateJob(jobId, { status: "failed", error: "Polling timeout" });
  }
  ```

- [ ] **Step 2: 编写测试 `tests/services/digital-human.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
  import { rm } from "node:fs/promises";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import * as configModule from "../../src/config.js";
  import { importAvatar, submitJob, refreshJob } from "../../src/services/digital-human.js";

  describe("digital-human service", () => {
    beforeEach(() => {
      resetInMemoryDb();
      migrate();
      vi.spyOn(configModule, "loadConfig").mockResolvedValue({
        port: 3271,
        model: "sonnet",
        jimeng: { accessKey: "", secretKey: "" },
        research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
        chanjing: { appId: "app", secretKey: "secret" },
      } as any);
      vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => closeDb());

    it("submits and refreshes a ChanJing job", async () => {
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) }) // token
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { job_id: "job1" } }) }) // submit
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) }) // token
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 3, video_url: "https://v.mp4" } }) }) // query
        .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer }); // download

      const avatar = await importAvatar("Host", "cj_avatar_1");
      const job = await submitJob({ avatarId: avatar.id, audioUrl: "/works/w1/assets/audio/voice.mp3", estimatedCost: 0.5 });
      expect(job.status).toBe("pending");
      await new Promise((r) => setTimeout(r, 50));
      const refreshed = await refreshJob(job.id);
      expect(refreshed?.status).toBe("done");
      expect(refreshed?.result_local_path).toContain("output.mp4");
      if (refreshed?.result_local_path) await rm(refreshed.result_local_path, { force: true });
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/services/digital-human.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/services/digital-human.ts tests/services/digital-human.test.ts
  git commit -m "feat(dh): add digital human orchestration service"
  ```

---

## Task 8: 合规素材库服务

**Files:**
- Create: `src/services/asset-library.ts`
- Test: `tests/services/asset-library.test.ts`

- [ ] **Step 1: 实现 `src/services/asset-library.ts`**

  ```ts
  import { extname } from "node:path";
  import { saveSharedAsset, deleteSharedAsset, validateCategory } from "../shared-assets.js";
  import * as assetsRepo from "../db/assets-repo.js";
  import type { DbAsset, DbAssetCategory, DbAssetType, DbAssetSource, DbAssetLicense } from "../db/types.js";

  function detectType(filename: string): DbAssetType {
    const ext = extname(filename).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)) return "image";
    if ([".mp4", ".mov", ".webm", ".avi"].includes(ext)) return "video";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".flac"].includes(ext)) return "audio";
    if ([".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "font";
    return "other";
  }

  function sanitizeName(name: string): string {
    const base = name.replace(/[\\/:*?\"<>|]/g, "_").trim();
    return base || `asset_${Date.now()}`;
  }

  export function checkCompliance(asset: Pick<DbAsset, "source" | "license" | "metadata">): DbAsset["compliance_status"] {
    if (asset.source === "self-generated") return "passed";
    if (["pexels", "pixabay", "unsplash"].includes(asset.source) && ["cc0", "commercial"].includes(asset.license)) return "passed";
    if (asset.source === "upload" && asset.license === "commercial") return "passed";
    if (asset.source === "upload" && asset.license === "needs-review") return "pending";
    return "pending";
  }

  export async function uploadAsset(input: {
    name: string;
    data: Buffer;
    category: DbAssetCategory;
    type?: DbAssetType;
    source?: DbAssetSource;
    license?: DbAssetLicense;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<DbAsset> {
    validateCategory(input.category);
    const type = input.type ?? detectType(input.name);
    const source = input.source ?? "upload";
    const license = input.license ?? (source === "upload" ? "needs-review" : "unknown");
    const safeName = sanitizeName(input.name);
    const saved = await saveSharedAsset(input.category, safeName, input.data);
    const asset = assetsRepo.createAsset({
      name: saved.name,
      file_path: `${input.category}/${saved.name}`,
      category: input.category,
      type,
      tags: input.tags ?? [],
      source,
      license,
      compliance_status: "pending",
      metadata: input.metadata ?? {},
      usage_count: 0,
    });
    const status = checkCompliance(asset);
    return assetsRepo.updateAsset(asset.id, { compliance_status: status }) ?? asset;
  }

  export async function importAssetFromUrl(input: {
    url: string;
    category: DbAssetCategory;
    name?: string;
    type?: DbAssetType;
    source?: DbAssetSource;
    license?: DbAssetLicense;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<DbAsset> {
    validateCategory(input.category);
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const name = input.name ?? `download_${Date.now()}.bin`;
    return uploadAsset({ ...input, name, data });
  }

  export function listAssets(filters?: Parameters<typeof assetsRepo.listAssets>[0]) {
    const rows = assetsRepo.listAssets(filters);
    return rows.map((a) => ({ ...a, url: `/api/shared-assets/${encodeURIComponent(a.category)}/${encodeURIComponent(a.name)}` }));
  }

  export async function updateAsset(id: number, updates: Partial<Omit<DbAsset, "id" | "created_at" | "updated_at">>): Promise<DbAsset | undefined> {
    const updated = assetsRepo.updateAsset(id, updates);
    if (!updated) return undefined;
    const status = checkCompliance(updated);
    return assetsRepo.updateAsset(id, { compliance_status: status }) ?? updated;
  }

  export async function deleteAsset(id: number): Promise<boolean> {
    const asset = assetsRepo.getAsset(id);
    if (!asset) return false;
    try { await deleteSharedAsset(asset.category, asset.name); } catch { /* file may already be gone */ }
    return assetsRepo.deleteAsset(id);
  }

  export async function recheckCompliance(id: number): Promise<DbAsset | undefined> {
    const asset = assetsRepo.getAsset(id);
    if (!asset) return undefined;
    const status = checkCompliance(asset);
    return assetsRepo.updateAsset(id, { compliance_status: status });
  }
  ```

- [ ] **Step 2: 编写测试 `tests/services/asset-library.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { existsSync } from "node:fs";
  import { rm } from "node:fs/promises";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import { uploadAsset, listAssets, updateAsset, deleteAsset, checkCompliance } from "../../src/services/asset-library.js";

  describe("asset-library service", () => {
    beforeEach(() => { resetInMemoryDb(); migrate(); });
    afterEach(() => closeDb());

    it("uploads and checks compliance", async () => {
      const asset = await uploadAsset({
        name: "happy.mp3",
        data: Buffer.from("fake audio"),
        category: "music",
        source: "pexels",
        license: "cc0",
        tags: ["bgm"],
      });
      expect(asset.compliance_status).toBe("passed");
      expect(listAssets({ category: "music" })[0].name).toBe(asset.name);
      const deleted = await deleteAsset(asset.id);
      expect(deleted).toBe(true);
      if (asset.file_path && !existsSync(asset.file_path)) {
        // file_path is relative; actual absolute path under shared-assets
      }
    });

    it("flags upload without commercial license as pending", () => {
      expect(checkCompliance({ source: "upload", license: "needs-review", metadata: {} })).toBe("pending");
      expect(checkCompliance({ source: "upload", license: "commercial", metadata: {} })).toBe("passed");
    });
  });
  ```

- [ ] **Step 3: 运行测试**

  Run: `npx vitest run tests/services/asset-library.test.ts`

  Expected: PASS.

- [ ] **Step 4: 提交**

  ```bash
  git add src/services/asset-library.ts tests/services/asset-library.test.ts
  git commit -m "feat(assets): add asset library service with compliance checks"
  ```

---

## Task 9: 数字人与素材库 API 路由

**Files:**
- Modify: `src/server/api.ts`
- Test: `tests/server/api-digital-human.test.ts`
- Test: `tests/server/api-assets.test.ts`

- [ ] **Step 1: 在 `src/server/api.ts` 顶部添加 import**

  在已有 `import { getLatestCreatorData, ... } from "../analytics-collector.js";` 之后追加：

  ```ts
  import * as avatarsRepo from "../db/avatars-repo.js";
  import * as dhJobsRepo from "../db/digital-human-jobs-repo.js";
  import * as assetsRepo from "../db/assets-repo.js";
  import {
    createAvatarFromUpload,
    importAvatar,
    setDefaultAvatar,
    submitJob,
    refreshJob,
  } from "../services/digital-human.js";
  import {
    uploadAsset as uploadLibraryAsset,
    listAssets as listLibraryAssets,
    updateAsset as updateLibraryAsset,
    deleteAsset as deleteLibraryAsset,
    recheckCompliance,
  } from "../services/asset-library.js";
  ```

  同时把 `node:fs/promises` 的 import 改为：

  ```ts
  import { readFile, writeFile, appendFile, mkdir, readdir, rm } from "node:fs/promises";
  ```

- [ ] **Step 2: 在文件末尾追加路由块**

  在 `api.ts` 最后一行之后追加：

  ```ts
  // ---------------------------------------------------------------------------
  // Digital Human API
  // ---------------------------------------------------------------------------

  function avatarDir(id: string): string { return join(dataDir, "avatars", id); }
  function jobOutputDir(id: string): string { return join(dataDir, "digital-human-jobs", id); }

  function guessMime(filename: string): string {
    const ext = extname(filename).toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
  }

  // GET /api/digital-humans/status
  apiRoutes.get("/api/digital-humans/status", async (c) => {
    const config = await loadConfig();
    return c.json({
      chanjing: !!config.chanjing?.appId && !!config.chanjing?.secretKey,
      bailian: !!config.bailian?.apiKey,
    });
  });

  // GET /api/digital-humans/avatars
  apiRoutes.get("/api/digital-humans/avatars", async (c) => {
    return c.json({ avatars: avatarsRepo.listAvatars() });
  });

  // POST /api/digital-humans/avatars — upload file or import existing provider avatar
  apiRoutes.post("/api/digital-humans/avatars", async (c) => {
    try {
      const ct = c.req.header("content-type") ?? "";
      if (ct.includes("application/json")) {
        const { name, providerAvatarId } = await c.req.json();
        if (!name || !providerAvatarId) return c.json({ error: "name and providerAvatarId required" }, 400);
        const avatar = await importAvatar(name, providerAvatarId);
        return c.json(avatar, 201);
      }
      const body = await c.req.parseBody();
      const name = (body.name as string) || "New Avatar";
      const file = body.file as File | undefined;
      if (!file) return c.json({ error: "file is required" }, 400);
      const buffer = Buffer.from(await file.arrayBuffer());
      const avatar = await createAvatarFromUpload(name, buffer, file.name);
      return c.json(avatar, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Avatar creation failed" }, 500);
    }
  });

  // GET /api/digital-humans/avatars/:id
  apiRoutes.get("/api/digital-humans/avatars/:id", async (c) => {
    const id = c.req.param("id");
    const avatar = avatarsRepo.getAvatar(id);
    if (!avatar) return c.json({ error: "Avatar not found" }, 404);
    return c.json(avatar);
  });

  // GET /api/digital-humans/avatars/:id/media/:filename
  apiRoutes.get("/api/digital-humans/avatars/:id/media/:filename", async (c) => {
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    try {
      const data = await readFile(join(avatarDir(id), filename));
      return new Response(data, { headers: { "Content-Type": guessMime(filename) } });
    } catch {
      return c.json({ error: "Media not found" }, 404);
    }
  });

  // GET /api/digital-humans/avatars/:id/frame
  apiRoutes.get("/api/digital-humans/avatars/:id/frame", async (c) => {
    const id = c.req.param("id");
    try {
      const data = await readFile(join(avatarDir(id), "frame.jpg"));
      return new Response(data, { headers: { "Content-Type": "image/jpeg" } });
    } catch {
      return c.json({ error: "Frame not found" }, 404);
    }
  });

  // DELETE /api/digital-humans/avatars/:id
  apiRoutes.delete("/api/digital-humans/avatars/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await rm(avatarDir(id), { recursive: true, force: true });
    } catch { /* directory may not exist */ }
    const ok = avatarsRepo.deleteAvatar(id);
    return c.json({ deleted: ok });
  });

  // POST /api/digital-humans/avatars/:id/default
  apiRoutes.post("/api/digital-humans/avatars/:id/default", async (c) => {
    const id = c.req.param("id");
    const avatar = await setDefaultAvatar(id);
    if (!avatar) return c.json({ error: "Avatar not found" }, 404);
    return c.json(avatar);
  });

  // POST /api/digital-humans/jobs
  apiRoutes.post("/api/digital-humans/jobs", async (c) => {
    try {
      const body = await c.req.json();
      const { avatarId, audioUrl, workId, scriptId, estimatedCost, fallbackOnFailure } = body;
      if (!avatarId || !audioUrl) return c.json({ error: "avatarId and audioUrl required" }, 400);
      const job = await submitJob({ avatarId, audioUrl, workId, scriptId, estimatedCost, fallbackOnFailure });
      return c.json(job, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Job submission failed" }, 500);
    }
  });

  // GET /api/digital-humans/jobs
  apiRoutes.get("/api/digital-humans/jobs", async (c) => {
    return c.json({ jobs: dhJobsRepo.listJobs() });
  });

  // GET /api/digital-humans/jobs/:id
  apiRoutes.get("/api/digital-humans/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const job = dhJobsRepo.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  });

  // POST /api/digital-humans/jobs/:id/refresh
  apiRoutes.post("/api/digital-humans/jobs/:id/refresh", async (c) => {
    const id = c.req.param("id");
    try {
      const job = await refreshJob(id);
      if (!job) return c.json({ error: "Job not found" }, 404);
      return c.json(job);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Refresh failed" }, 500);
    }
  });

  // GET /api/digital-humans/jobs/:id/output
  apiRoutes.get("/api/digital-humans/jobs/:id/output", async (c) => {
    const id = c.req.param("id");
    try {
      const data = await readFile(join(jobOutputDir(id), "output.mp4"));
      return new Response(data, { headers: { "Content-Type": "video/mp4" } });
    } catch {
      return c.json({ error: "Output not found" }, 404);
    }
  });

  // ---------------------------------------------------------------------------
  // Asset Library API
  // ---------------------------------------------------------------------------

  // GET /api/assets
  apiRoutes.get("/api/assets", async (c) => {
    const category = c.req.query("category") as any;
    const type = c.req.query("type") as any;
    const source = c.req.query("source") as any;
    const tag = c.req.query("tag");
    const compliance = c.req.query("compliance") as any;
    const assets = listLibraryAssets({ category, type, source, tag, compliance });
    return c.json({ assets });
  });

  // POST /api/assets
  apiRoutes.post("/api/assets", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body.file as File | undefined;
      if (!file) return c.json({ error: "file is required" }, 400);
      const category = (body.category as any) || "other";
      const source = (body.source as any) || "upload";
      const license = (body.license as any) || (source === "upload" ? "needs-review" : "unknown");
      const tagsRaw = (body.tags as string) || "";
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      const metadata = body.metadata ? JSON.parse(body.metadata as string) : {};
      const buffer = Buffer.from(await file.arrayBuffer());
      const asset = await uploadLibraryAsset({
        name: file.name,
        data: buffer,
        category,
        source,
        license,
        tags,
        metadata,
      });
      return c.json(asset, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Asset upload failed" }, 500);
    }
  });

  // GET /api/assets/:id
  apiRoutes.get("/api/assets/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const asset = assetsRepo.getAsset(id);
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json({ ...asset, url: `/api/shared-assets/${encodeURIComponent(asset.category)}/${encodeURIComponent(asset.name)}` });
  });

  // PUT /api/assets/:id
  apiRoutes.put("/api/assets/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    try {
      const body = await c.req.json();
      const allowed = ["name", "category", "type", "tags", "source", "license", "metadata"];
      const updates = Object.fromEntries(allowed.filter((k) => k in body).map((k) => [k, body[k]]));
      const asset = await updateLibraryAsset(id, updates);
      if (!asset) return c.json({ error: "Asset not found" }, 404);
      return c.json(asset);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Update failed" }, 500);
    }
  });

  // DELETE /api/assets/:id
  apiRoutes.delete("/api/assets/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const ok = await deleteLibraryAsset(id);
    return c.json({ deleted: ok });
  });

  // POST /api/assets/:id/compliance
  apiRoutes.post("/api/assets/:id/compliance", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const asset = await recheckCompliance(id);
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json(asset);
  });
  ```

- [ ] **Step 3: 编写数字人路由测试 `tests/server/api-digital-human.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
  import { rm } from "node:fs/promises";
  import { apiRoutes } from "../../src/server/api.js";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";
  import * as configModule from "../../src/config.js";

  describe("digital-human API", () => {
    beforeEach(() => {
      resetInMemoryDb();
      migrate();
      vi.spyOn(configModule, "loadConfig").mockResolvedValue({
        port: 3271, model: "sonnet", jimeng: { accessKey: "", secretKey: "" },
        research: { enabled: false, schedule: "0 9 * * *", platforms: [] },
        chanjing: { appId: "app", secretKey: "secret" },
      } as any);
      vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => closeDb());

    it("imports avatar and submits job end-to-end", async () => {
      const fetchMock = fetch as ReturnType<typeof vi.fn>;
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { job_id: "job1" } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 3, video_url: "https://v.mp4" } }) })
        .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([0, 1, 2]).buffer });

      const res1 = await apiRoutes.request("/api/digital-humans/avatars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Host", providerAvatarId: "cj_1" }),
      });
      expect(res1.status).toBe(201);
      const avatar = await res1.json();

      const res2 = await apiRoutes.request("/api/digital-humans/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarId: avatar.id, audioUrl: "/a.mp3", estimatedCost: 0.5 }),
      });
      expect(res2.status).toBe(201);
      const job = await res2.json();
      await new Promise((r) => setTimeout(r, 50));

      const res3 = await apiRoutes.request(`/api/digital-humans/jobs/${job.id}/refresh`, { method: "POST" });
      expect(res3.status).toBe(200);
      const refreshed = await res3.json();
      expect(refreshed.status).toBe("done");
      if (refreshed.result_local_path) await rm(refreshed.result_local_path, { force: true });
    });
  });
  ```

- [ ] **Step 4: 编写素材库路由测试 `tests/server/api-assets.test.ts`**

  ```ts
  import { describe, it, expect, beforeEach, afterEach } from "vitest";
  import { apiRoutes } from "../../src/server/api.js";
  import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
  import { migrate } from "../../src/db/migrate.js";

  describe("asset library API", () => {
    beforeEach(() => { resetInMemoryDb(); migrate(); });
    afterEach(() => closeDb());

    it("uploads, lists and deletes an asset", async () => {
      const form = new FormData();
      form.append("file", new File([Buffer.from("fake audio")], "bgm.mp3", { type: "audio/mpeg" }));
      form.append("category", "music");
      form.append("source", "pexels");
      form.append("license", "cc0");
      form.append("tags", "bgm,intro");

      const res1 = await apiRoutes.request("/api/assets", { method: "POST", body: form });
      expect(res1.status).toBe(201);
      const asset = await res1.json();
      expect(asset.compliance_status).toBe("passed");

      const res2 = await apiRoutes.request("/api/assets");
      expect(res2.status).toBe(200);
      const { assets } = await res2.json();
      expect(assets.length).toBe(1);

      const res3 = await apiRoutes.request(`/api/assets/${asset.id}`, { method: "DELETE" });
      expect(res3.status).toBe(200);
    });
  });
  ```

- [ ] **Step 5: 运行测试**

  Run:

  ```bash
  npx vitest run tests/server/api-digital-human.test.ts tests/server/api-assets.test.ts
  ```

  Expected: both PASS.

- [ ] **Step 6: 提交**

  ```bash
  git add src/server/api.ts tests/server/api-digital-human.test.ts tests/server/api-assets.test.ts
  git commit -m "feat(api): add digital-human and asset-library routes"
  ```

---

## Task 10: 前端 API 封装与 i18n 文案

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/i18n.ts`

- [ ] **Step 1: 在 `web/src/lib/api.ts` 末尾追加数字人与素材库封装**

  ```ts
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
    category: "music" | "sfx" | "footage" | "images" | "fonts" | "stickers" | "other";
    type: "image" | "video" | "audio" | "font" | "other";
    tags: string[];
    source: "upload" | "pexels" | "pixabay" | "unsplash" | "self-generated" | "other";
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
  ```

- [ ] **Step 2: 扩展 `web/src/lib/i18n.ts` 文案**

  在 `en` 区块的 `analytics` 之后插入导航项：

  ```ts
    topics: "Topics",
    digitalHumans: "Digital Humans",
    assetLibrary: "Asset Library",
  ```

  在 `en` 区块末尾（`lightTheme` 之后）追加：

  ```ts
    // Digital Human
    digitalHumansTitle: "Digital Humans",
    avatars: "Avatars",
    uploadAvatar: "Upload Avatar",
    importAvatar: "Import Provider Avatar",
    avatarName: "Avatar Name",
    providerAvatarId: "Provider Avatar ID",
    submitJob: "Submit Job",
    audioUrl: "Audio URL / Path",
    selectAvatar: "Select Avatar",
    refresh: "Refresh",
    download: "Download",
    jobSubmitted: "Job submitted.",
    avatarUploaded: "Avatar uploaded.",
    avatarImported: "Avatar imported.",
    statusPending: "Pending",
    statusRunning: "Running",
    statusDone: "Done",
    statusFailed: "Failed",

    // Asset Library
    assetLibraryTitle: "Asset Library",
    uploadAsset: "Upload Asset",
    category: "Category",
    type: "Type",
    source: "Source",
    license: "License",
    tags: "Tags",
    compliance: "Compliance",
    compliancePassed: "Passed",
    compliancePending: "Pending",
    complianceFailed: "Failed",
    recheck: "Recheck",
    filters: "Filters",
    assetUploaded: "Asset uploaded.",
  ```

  在 `zh` 区块的 `analytics` 之后插入导航项：

  ```ts
    topics: "选题中心",
    digitalHumans: "数字人",
    assetLibrary: "素材库",
  ```

  在 `zh` 区块末尾追加：

  ```ts
    // 数字人
    digitalHumansTitle: "数字人",
    avatars: "形象",
    uploadAvatar: "上传形象",
    importAvatar: "导入蝉镜形象",
    avatarName: "形象名称",
    providerAvatarId: "Provider 形象 ID",
    submitJob: "提交合成任务",
    audioUrl: "音频 URL / 路径",
    selectAvatar: "选择形象",
    refresh: "刷新",
    download: "下载",
    jobSubmitted: "任务已提交",
    avatarUploaded: "形象已上传",
    avatarImported: "形象已导入",
    statusPending: "待处理",
    statusRunning: "进行中",
    statusDone: "完成",
    statusFailed: "失败",

    // 素材库
    assetLibraryTitle: "合规素材库",
    uploadAsset: "上传素材",
    category: "分类",
    type: "类型",
    source: "来源",
    license: "授权",
    tags: "标签",
    compliance: "合规",
    compliancePassed: "已通过",
    compliancePending: "待审核",
    complianceFailed: "未通过",
    recheck: "重检",
    filters: "筛选",
    assetUploaded: "素材已上传",
  ```

- [ ] **Step 3: 运行类型检查**

  Run: `npx tsc --noEmit -p web/tsconfig.json` (或项目已有的 web 类型检查命令)

  Expected: no errors.

- [ ] **Step 4: 提交**

  ```bash
  git add web/src/lib/api.ts web/src/lib/i18n.ts
  git commit -m "feat(web): add digital-human and asset-library API wrappers + i18n"
  ```

---

## Task 11: 数字人管理页面

**Files:**
- Create: `web/src/pages/DigitalHumans.svelte`

- [ ] **Step 1: 创建页面**

  ```svelte
  <script lang="ts">
    import { onMount } from "svelte";
    import {
      fetchAvatars, uploadAvatar, importAvatar, fetchDigitalHumanJobs,
      submitDigitalHumanJob, refreshDigitalHumanJob, type Avatar, type DigitalHumanJob,
    } from "../lib/api.js";
    import { t, getLanguage, subscribe } from "../lib/i18n.js";

    let lang = $state(getLanguage());
    let avatars = $state<Avatar[]>([]);
    let jobs = $state<DigitalHumanJob[]>([]);
    let newName = $state("");
    let uploadFiles = $state<FileList | null>(null);
    let providerAvatarId = $state("");
    let audioUrl = $state("");
    let selectedAvatarId = $state("");
    let busy = $state(false);
    let message = $state("");

    onMount(() => {
      const unsub = subscribe(() => { lang = getLanguage(); });
      load();
      return () => unsub();
    });

    function tt(key: string): string { void lang; return t(key); }

    async function load() {
      const [a, j] = await Promise.all([fetchAvatars(), fetchDigitalHumanJobs()]);
      avatars = a;
      jobs = j;
    }

    async function handleUpload() {
      if (!uploadFiles?.length || !newName) return;
      busy = true;
      try {
        await uploadAvatar(newName, uploadFiles[0]);
        newName = "";
        uploadFiles = null;
        message = tt("avatarUploaded");
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
      }
    }

    async function handleImport() {
      if (!newName || !providerAvatarId) return;
      busy = true;
      try {
        await importAvatar(newName, providerAvatarId);
        newName = "";
        providerAvatarId = "";
        message = tt("avatarImported");
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
      }
    }

    async function handleSubmitJob() {
      if (!selectedAvatarId || !audioUrl) return;
      busy = true;
      try {
        await submitDigitalHumanJob({ avatarId: selectedAvatarId, audioUrl });
        audioUrl = "";
        message = tt("jobSubmitted");
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
      }
    }

    async function handleRefresh(jobId: string) {
      try {
        await refreshDigitalHumanJob(jobId);
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    }
  </script>

  <div class="page">
    <h1>{tt("digitalHumansTitle")}</h1>
    {#if message}<p class="message">{message}</p>{/if}

    <section class="panel">
      <h2>{tt("uploadAvatar")}</h2>
      <div class="row">
        <input type="text" bind:value={newName} placeholder={tt("avatarName")} />
        <input type="file" accept="video/*,image/*" bind:files={uploadFiles} />
        <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAsset")}</button>
      </div>
    </section>

    <section class="panel">
      <h2>{tt("importAvatar")}</h2>
      <div class="row">
        <input type="text" bind:value={newName} placeholder={tt("avatarName")} />
        <input type="text" bind:value={providerAvatarId} placeholder={tt("providerAvatarId")} />
        <button class="btn-primary" disabled={busy} onclick={handleImport}>{tt("importAvatar")}</button>
      </div>
    </section>

    <section class="panel">
      <h2>{tt("avatars")}</h2>
      <ul class="list">
        {#each avatars as a}
          <li class="avatar-card">
            {#if a.preview_url}
              <img src={a.preview_url} alt={a.name} class="thumb" />
            {/if}
            <div class="info">
              <span class="name">{a.name}</span>
              <span class="badge">{a.status}</span>
              <span class="meta">{a.source}</span>
            </div>
          </li>
        {/each}
      </ul>
    </section>

    <section class="panel">
      <h2>{tt("submitJob")}</h2>
      <div class="row">
        <select bind:value={selectedAvatarId}>
          <option value="">{tt("selectAvatar")}</option>
          {#each avatars as a}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
        <input type="text" bind:value={audioUrl} placeholder={tt("audioUrl")} />
        <button class="btn-primary" disabled={busy} onclick={handleSubmitJob}>{tt("submitJob")}</button>
      </div>

      <ul class="list">
        {#each jobs as j}
          <li class="job-row">
            <span class="name">{j.id}</span>
            <span class="badge">{j.status}</span>
            <span class="meta">{j.progress}%</span>
            <button class="btn-sm" onclick={() => handleRefresh(j.id)}>{tt("refresh")}</button>
            {#if j.status === "done"}
              <a class="btn-sm" href={`/api/digital-humans/jobs/${encodeURIComponent(j.id)}/output`} target="_blank">{tt("download")}</a>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  </div>

  <style>
    .page { padding: 2rem; color: var(--text); font-family: var(--font-body); }
    h1 { font-family: var(--font-display); font-size: var(--size-2xl); margin-bottom: 1.5rem; }
    h2 { font-size: var(--size-lg); margin: 0 0 0.75rem; color: var(--text-secondary); }
    .panel { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
    .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    input, select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; }
    .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; text-decoration: none; }
    .message { color: var(--spark-red); margin-bottom: 1rem; }
    .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .avatar-card, .job-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
    .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; }
    .info { display: flex; flex-direction: column; gap: 0.25rem; }
    .name { font-weight: 600; }
    .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; width: fit-content; }
    .meta { font-size: var(--size-sm); color: var(--text-muted); }
  </style>
  ```

- [ ] **Step 2: 提交**

  ```bash
  git add web/src/pages/DigitalHumans.svelte
  git commit -m "feat(web): add digital humans management page"
  ```

---

## Task 12: 合规素材库页面

**Files:**
- Create: `web/src/pages/Assets.svelte`

- [ ] **Step 1: 创建页面**

  ```svelte
  <script lang="ts">
    import { onMount } from "svelte";
    import {
      fetchLibraryAssets, uploadLibraryAsset, deleteLibraryAsset,
      recheckAssetCompliance, type AssetLibraryItem,
    } from "../lib/api.js";
    import { t, getLanguage, subscribe } from "../lib/i18n.js";

    let lang = $state(getLanguage());
    let assets = $state<AssetLibraryItem[]>([]);
    let uploadFiles = $state<FileList | null>(null);
    let category = $state<AssetLibraryItem["category"]>("music");
    let source = $state<AssetLibraryItem["source"]>("upload");
    let license = $state<AssetLibraryItem["license"]>("needs-review");
    let tags = $state("");
    let filterCategory = $state<AssetLibraryItem["category"] | "" >("");
    let busy = $state(false);
    let message = $state("");

    const categories: AssetLibraryItem["category"][] = ["music", "sfx", "footage", "images", "fonts", "stickers", "other"];
    const sources: AssetLibraryItem["source"][] = ["upload", "pexels", "pixabay", "unsplash", "self-generated", "other"];
    const licenses: AssetLibraryItem["license"][] = ["cc0", "commercial", "needs-review", "unknown"];

    onMount(() => {
      const unsub = subscribe(() => { lang = getLanguage(); });
      load();
      return () => unsub();
    });

    function tt(key: string): string { void lang; return t(key); }

    async function load() {
      assets = await fetchLibraryAssets(filterCategory || undefined);
    }

    async function handleUpload() {
      if (!uploadFiles?.length) return;
      busy = true;
      try {
        await uploadLibraryAsset(uploadFiles[0], category, source, license, tags);
        uploadFiles = null;
        tags = "";
        message = tt("assetUploaded");
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
      }
    }

    async function handleDelete(id: number) {
      if (!confirm(tt("confirmDelete"))) return;
      try {
        await deleteLibraryAsset(id);
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    }

    async function handleRecheck(id: number) {
      try {
        await recheckAssetCompliance(id);
        await load();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
    }
  </script>

  <div class="page">
    <h1>{tt("assetLibraryTitle")}</h1>
    {#if message}<p class="message">{message}</p>{/if}

    <section class="panel">
      <h2>{tt("uploadAsset")}</h2>
      <div class="row">
        <input type="file" bind:files={uploadFiles} />
        <select bind:value={category}>
          {#each categories as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
        <select bind:value={source}>
          {#each sources as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
        <select bind:value={license}>
          {#each licenses as l}
            <option value={l}>{l}</option>
          {/each}
        </select>
        <input type="text" bind:value={tags} placeholder={tt("tags")} />
        <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAsset")}</button>
      </div>
    </section>

    <section class="panel">
      <h2>{tt("filters")}</h2>
      <select bind:value={filterCategory} onchange={load}>
        <option value="">{tt("filterAll")}</option>
        {#each categories as c}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </section>

    <ul class="list">
      {#each assets as a}
        <li class="asset-row">
          <span class="name">{a.name}</span>
          <span class="badge">{a.type}</span>
          <span class="badge compliance-{a.compliance_status}">{a.compliance_status}</span>
          <span class="meta">{(a.tags || []).join(", ")}</span>
          <button class="btn-sm" onclick={() => handleRecheck(a.id)}>{tt("recheck")}</button>
          <button class="btn-sm" onclick={() => handleDelete(a.id)}>{tt("delete")}</button>
        </li>
      {/each}
    </ul>
  </div>

  <style>
    .page { padding: 2rem; color: var(--text); font-family: var(--font-body); }
    h1 { font-family: var(--font-display); font-size: var(--size-2xl); margin-bottom: 1.5rem; }
    h2 { font-size: var(--size-lg); margin: 0 0 0.75rem; color: var(--text-secondary); }
    .panel { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
    .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    input, select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; }
    .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; cursor: pointer; }
    .message { color: var(--spark-red); margin-bottom: 1rem; }
    .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .asset-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
    .name { font-weight: 600; flex: 1; }
    .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; }
    .compliance-passed { background: var(--success-soft); color: var(--success); }
    .compliance-pending { background: rgba(245, 158, 11, 0.1); color: var(--state-running); }
    .compliance-failed { background: var(--error-soft); color: var(--error); }
    .meta { font-size: var(--size-sm); color: var(--text-muted); }
  </style>
  ```

- [ ] **Step 2: 提交**

  ```bash
  git add web/src/pages/Assets.svelte
  git commit -m "feat(web): add compliant asset library page"
  ```

---

## Task 13: 全局导航更新

**Files:**
- Modify: `web/src/App.svelte`

- [ ] **Step 1: 导入新页面并扩展 Tab 类型**

  将 `import Works from "./pages/Works.svelte";` 改为：

  ```ts
  import Works from "./pages/Works.svelte";
  import Topics from "./pages/Topics.svelte";
  import DigitalHumans from "./pages/DigitalHumans.svelte";
  import Assets from "./pages/Assets.svelte";
  ```

  将 `type Tab = "explore" | "works" | "analytics";` 改为：

  ```ts
  type Tab = "explore" | "works" | "topics" | "digital-humans" | "assets" | "analytics";
  ```

- [ ] **Step 2: 扩展导航项**

  将 `navItems` 数组替换为：

  ```ts
  const navItems = [
    { tab: "works" as Tab, labelKey: "works" },
    { tab: "topics" as Tab, labelKey: "topics" },
    { tab: "digital-humans" as Tab, labelKey: "digitalHumans" },
    { tab: "assets" as Tab, labelKey: "assetLibrary" },
    { tab: "explore" as Tab, labelKey: "explore" },
    { tab: "analytics" as Tab, labelKey: "analytics" },
  ];
  ```

- [ ] **Step 3: 在 main 渲染分支中添加新页面**

  将：

  ```svelte
    {:else if activeTab === "analytics"}
      <Analytics />
    {:else}
      <Works
        onOpenStudio={openStudio}
        onCreateNew={() => showNewWorkModal = true}
        onCreateFromTrend={handleCreateFromTrend}
        onGoToInsights={() => { activeTab = "explore"; }}
      />
    {/if}
  ```

  替换为：

  ```svelte
    {:else if activeTab === "analytics"}
      <Analytics />
    {:else if activeTab === "topics"}
      <Topics />
    {:else if activeTab === "digital-humans"}
      <DigitalHumans />
    {:else if activeTab === "assets"}
      <Assets />
    {:else if activeTab === "works"}
      <Works
        onOpenStudio={openStudio}
        onCreateNew={() => showNewWorkModal = true}
        onCreateFromTrend={handleCreateFromTrend}
        onGoToInsights={() => { activeTab = "explore"; }}
      />
    {/if}
  ```

- [ ] **Step 4: 构建前端**

  Run: `npm run build:frontend`

  Expected: 构建成功，无 TypeScript/Svelte 错误。

- [ ] **Step 5: 提交**

  ```bash
  git add web/src/App.svelte
  git commit -m "feat(web): add topics, digital-human and asset-library navigation"
  ```

---

## Task 14: 自审、验收与计划文件提交

- [ ] **Step 1: 占位符扫描**

  在计划文件内搜索以下关键词，确认未出现：

  ```bash
  grep -n -E "TODO|TBD|FIXME|placeholder|implement later|fill in details" docs/superpowers/plans/2026-07-08-autoviral-mcn-redesign-phase2.md || echo "No placeholders found"
  ```

  Expected: `No placeholders found`。

- [ ] **Step 2: 类型一致性检查**

  确认以下命名在任务间完全一致：
  - DB 表名：`avatars`、`digital_human_jobs`、`asset_library`
  - TypeScript 类型：`DbAvatar`、`DbDigitalHumanJob`、`DbAsset`
  - 服务函数：`createAvatarFromUpload`、`importAvatar`、`submitJob`、`refreshJob`、`uploadAsset`、`listAssets`、`updateAsset`、`deleteAsset`
  - 前端页面：`DigitalHumans.svelte`、`Assets.svelte`

  若发现不一致，返回对应任务修正。

- [ ] **Step 3: 需求覆盖表**

  | PRD / 数据模型要求 | 实现任务 |
  |--------------------|----------|
  | 蝉镜 Open API 接入（token、形象、合成、查询） | Task 5 |
  | 百炼 LivePortrait 备用接入 | Task 6 |
  | `avatars` 表及仓库（上传、导入、默认形象） | Task 2、Task 7、Task 9 |
  | `digital_human_jobs` 表及仓库（异步任务、轮询） | Task 3、Task 7 |
  | 主备 Provider 调度与 fallback | Task 7 |
  | 结果视频下载与本地落盘 | Task 7、Task 9 |
  | `asset_library` 表及仓库 | Task 4 |
  | 素材分类 / 标签 / 来源 / 授权字段 | Task 1、Task 4 |
  | 基于来源+授权的合规初筛 | Task 8 |
  | 素材文件继续落地 `shared-assets/` | Task 8 |
  | 数字人与素材库 API 路由 | Task 9 |
  | 前端页面、导航、API 封装、i18n | Task 10–13 |
  | `works` 表扩展 `digital_human_id`、`asset_ids` | Task 1 |

  **不在本 Phase 范围内的 PRD 内容（后续 Phase 处理）：**
  - AI 自生成素材（PPT/图表/封面） → Phase 3
  - 视频工厂/模板引擎对数字人素材的调用 → Phase 3
  - 按内容形式自动选择不同数字人形象（目前仅支持默认形象设置） → Phase 3/5
  - `usage_count` 的自动累加与引用统计报表 → Phase 5

- [ ] **Step 4: 端到端验证命令**

  按顺序执行：

  ```bash
  # 1. 后端类型检查
  npm run build:backend

  # 2. 前端构建
  npm run build:frontend

  # 3. 运行本 Phase 新增/涉及的全部测试
  npx vitest run tests/db/avatars-repo.test.ts \
                tests/db/digital-human-jobs-repo.test.ts \
                tests/db/assets-repo.test.ts \
                tests/services/chanjing-client.test.ts \
                tests/services/bailian-client.test.ts \
                tests/services/digital-human.test.ts \
                tests/services/asset-library.test.ts \
                tests/server/api-digital-human.test.ts \
                tests/server/api-assets.test.ts

  # 4. 完整构建
  npm run build
  ```

  Expected: 所有命令返回 0，无 TypeScript/Svelte/Vitest 错误。

- [ ] **Step 5: 提交计划文件**

  ```bash
  git add docs/superpowers/plans/2026-07-08-autoviral-mcn-redesign-phase2.md
  git commit -m "docs(plan): add Phase 2 digital-human and asset-library implementation plan"
  ```

---

## 执行交接

**计划已完成并保存到 `docs/superpowers/plans/2026-07-08-autoviral-mcn-redesign-phase2.md`。**

请选择执行方式：

1. **Subagent-Driven（推荐）** — 为每个 Task 单独派发 subagent，逐任务 review，快速迭代。
2. **Inline Execution** — 在本会话中按任务顺序直接执行，适合一次性推进。

**注意：** 本计划假设 Phase 1 已合并；若 `Topics.svelte` 等 Phase 1 产物尚未就位，请先完成 Phase 1，再执行 Task 13 的导航更新。

