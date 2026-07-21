// Work store — manages persistent work (content) definitions for AutoViral
// Each work is a content piece flowing through a 4-step pipeline.
// Structured data is delegated to SQLite; file-system assets remain on disk.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { dataDir } from "./config.js";
import { migrateLegacyWorks } from "./db/migrate-legacy.js";
import {
  createWork as dbCreateWork,
  getWork as dbGetWork,
  getWorkSteps,
  listWorks as dbListWorks,
  updateWork as dbUpdateWork,
  deleteWork as dbDeleteWork,
  updateStep,
} from "./db/works-repo.js";
import type { DbWork, DbPipelineStep } from "./db/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkType = "short-video" | "image-text";
export type WorkStatus =
  | "draft"
  | "researching"
  | "planning"
  | "assetting"
  | "assembling"
  | "reviewing"
  | "published"
  | "failed";

export interface PipelineStep {
  name: string;
  status: "pending" | "active" | "evaluating" | "done" | "skipped" | "eval_blocked";
  startedAt?: string;
  completedAt?: string;
  note?: string;
}

export type ContentCategory = "anxiety" | "conflict" | "comedy" | "envy" | "other";
export type VideoSource = "upload" | "search" | "ai-generate";

export interface Work {
  id: string;
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  contentForm?: string;
  videoSource?: VideoSource;
  videoSearchQuery?: string;
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
  evaluationMode?: boolean;
  evalSessionIds?: Record<string, string>;
  evalAttempts?: Record<string, number>;
  estimatedCost?: number;
  actualCost?: number;
  reviewComment?: string;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight summary stored in the index file. */
export interface WorkSummary {
  id: string;
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  contentForm?: string;
  platforms?: string[];
  status: WorkStatus;
  topicId?: number;
  templateId?: string;
  digitalHumanId?: string;
  /** 流水线各阶段状态（作品卡片实时进度条） */
  pipeline?: Array<{ key: string; name: string; status: string }>;
  /** 审核预览视频 URL（成片，区别于封面图 coverImage） */
  previewUrl?: string;
  /** 最近一次发布中心打回的审核意见 */
  reviewComment?: string;
  updatedAt: string;
}

// ── Storage paths ────────────────────────────────────────────────────────────

const WORKS_BASE = join(dataDir, "works");

function workDir(id: string): string {
  return join(WORKS_BASE, id);
}

function workFilePath(id: string): string {
  return join(workDir(id), "work.yaml");
}

function assetsDir(id: string): string {
  return join(workDir(id), "assets");
}

function outputDir(id: string): string {
  return join(workDir(id), "output");
}

function toSummary(w: Work): WorkSummary {
  return { id: w.id, title: w.title, type: w.type, contentCategory: w.contentCategory, platforms: w.platforms, status: w.status, updatedAt: w.updatedAt };
}

// ── Pipeline templates ───────────────────────────────────────────────────────

function defaultPipeline(type: WorkType, videoSource?: VideoSource): Record<string, PipelineStep> {
  const result: Record<string, PipelineStep> = {};

  // Prepend material-search step if user chose web search for video source
  if (type === "short-video" && videoSource === "search") {
    result["material-search"] = { name: "素材搜索", status: "active", startedAt: new Date().toISOString() };
  }

  const names: Record<string, Record<string, string>> = {
    "short-video": { research: "话题调研", plan: "分镜规划", assets: "素材准备", assembly: "视频合成" },
    "image-text": { research: "话题调研", plan: "内容规划", assets: "图片生成", assembly: "图文排版" },
  };
  for (const [key, name] of Object.entries(names[type])) {
    result[key] = { name, status: "pending" };
  }
  return result;
}

// ── ID generation ────────────────────────────────────────────────────────────

function generateId(): string {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const hex = Math.random().toString(16).slice(2, 5);
  return `w_${ts}_${hex}`;
}

// ── DB ↔ Work conversion ─────────────────────────────────────────────────────

function dbWorkToWork(w: DbWork, steps?: DbPipelineStep[]): Work {
  const pipeline: Record<string, PipelineStep> = {};
  const stepRows = steps ?? getWorkSteps(w.id);
  for (const s of stepRows) {
    pipeline[s.step_key] = {
      name: s.name,
      status: s.status,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      note: s.note,
    };
  }
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    contentCategory: w.content_category as ContentCategory | undefined,
    contentForm: w.content_form,
    videoSource: w.video_source as VideoSource | undefined,
    videoSearchQuery: w.video_search_query,
    status: w.status,
    platforms: w.platforms,
    pipeline,
    cliSessionId: w.cli_session_id,
    coverImage: undefined,
    topicHint: w.topic_hint,
    topicId: w.topic_id,
    articleId: w.article_id,
    scriptId: w.script_id,
    digitalHumanId: w.digital_human_id,
    templateId: w.template_id,
    accountId: w.account_id ?? undefined,
    evaluationMode: w.evaluation_mode,
    evalSessionIds: w.eval_session_ids,
    evalAttempts: w.eval_attempts,
    estimatedCost: w.estimated_cost,
    actualCost: w.actual_cost,
    reviewComment: w.review_comment,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

let legacyMigrated = false;
async function maybeMigrateLegacy(): Promise<void> {
  if (legacyMigrated) return;
  legacyMigrated = true;
  await migrateLegacyWorks();
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listWorks(): Promise<WorkSummary[]> {
  await maybeMigrateLegacy();
  const rows = dbListWorks();
  return rows.map((w) => ({
    id: w.id,
    title: w.title,
    type: w.type,
    contentCategory: w.content_category as ContentCategory | undefined,
    contentForm: w.content_form,
    platforms: w.platforms,
    status: w.status,
    topicId: w.topic_id,
    templateId: w.template_id,
    digitalHumanId: w.digital_human_id,
    pipeline: getWorkSteps(w.id).map((s) => ({ key: s.step_key, name: s.name, status: s.status as string })),
    reviewComment: w.review_comment,
    updatedAt: w.updated_at,
  }));
}

export async function getWork(id: string): Promise<Work | undefined> {
  await maybeMigrateLegacy();
  const w = dbGetWork(id);
  if (!w) return undefined;
  return dbWorkToWork(w);
}

export async function createWork(input: {
  title: string;
  type: WorkType;
  contentCategory?: ContentCategory;
  contentForm?: string;
  videoSource?: VideoSource;
  videoSearchQuery?: string;
  platforms: string[];
  topicHint?: string;
  topicId?: number;
  accountId?: string;
  templateId?: string;
  digitalHumanId?: string;
}): Promise<Work> {
  await maybeMigrateLegacy();
  const now = new Date().toISOString();
  const id = generateId();
  const work: DbWork = {
    id,
    title: input.title,
    type: input.type,
    content_category: input.contentCategory,
    content_form: input.contentForm,
    video_source: input.videoSource,
    video_search_query: input.videoSearchQuery,
    status: input.videoSource === "search" ? "researching" : "draft",
    platforms: input.platforms,
    evaluation_mode: false,
    topic_hint: input.topicHint,
    topic_id: input.topicId,
    account_id: input.accountId,
    template_id: input.templateId,
    digital_human_id: input.digitalHumanId,
    tags: [],
    created_at: now,
    updated_at: now,
  };
  const steps = Object.entries(defaultPipeline(input.type, input.videoSource as VideoSource | undefined)).map(([key, s], idx) => ({
    work_id: id,
    step_key: key,
    name: s.name,
    status: s.status as DbPipelineStep["status"],
    started_at: s.startedAt,
    completed_at: s.completedAt,
    note: s.note,
    sort_order: idx,
  }));
  dbCreateWork(work, steps);

  // Keep on-disk workspace directories for assets
  const wDir = join(dataDir, "works", id);
  await mkdir(join(wDir, "research"), { recursive: true });
  await mkdir(join(wDir, "plan"), { recursive: true });
  await mkdir(join(wDir, "assets", "frames"), { recursive: true });
  await mkdir(join(wDir, "assets", "clips"), { recursive: true });
  await mkdir(join(wDir, "assets", "images"), { recursive: true });
  await mkdir(join(wDir, "output"), { recursive: true });

  return dbWorkToWork(work, steps);
}

export async function updateWork(id: string, updates: Partial<Work>): Promise<Work | undefined> {
  await maybeMigrateLegacy();
  const dbUpdates: Partial<DbWork> = {};
  if (updates.title !== undefined) dbUpdates.title = updates.title;
  if (updates.type !== undefined) dbUpdates.type = updates.type;
  if (updates.contentCategory !== undefined) dbUpdates.content_category = updates.contentCategory;
  if (updates.contentForm !== undefined) dbUpdates.content_form = updates.contentForm;
  if (updates.videoSource !== undefined) dbUpdates.video_source = updates.videoSource;
  if (updates.videoSearchQuery !== undefined) dbUpdates.video_search_query = updates.videoSearchQuery;
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.platforms !== undefined) dbUpdates.platforms = updates.platforms;
  if (updates.evaluationMode !== undefined) dbUpdates.evaluation_mode = updates.evaluationMode;
  if (updates.topicHint !== undefined) dbUpdates.topic_hint = updates.topicHint;
  if (updates.topicId !== undefined) dbUpdates.topic_id = updates.topicId;
  if (updates.articleId !== undefined) dbUpdates.article_id = updates.articleId;
  if (updates.scriptId !== undefined) dbUpdates.script_id = updates.scriptId;
  if (updates.digitalHumanId !== undefined) dbUpdates.digital_human_id = updates.digitalHumanId;
  if (updates.templateId !== undefined) dbUpdates.template_id = updates.templateId;
  if (updates.cliSessionId !== undefined) dbUpdates.cli_session_id = updates.cliSessionId;
  if (updates.evalSessionIds !== undefined) dbUpdates.eval_session_ids = updates.evalSessionIds;
  if (updates.evalAttempts !== undefined) dbUpdates.eval_attempts = updates.evalAttempts;
  if (updates.accountId !== undefined) dbUpdates.account_id = updates.accountId;
  if (updates.estimatedCost !== undefined) dbUpdates.estimated_cost = updates.estimatedCost;
  if (updates.actualCost !== undefined) dbUpdates.actual_cost = updates.actualCost;
  if (updates.reviewComment !== undefined) dbUpdates.review_comment = updates.reviewComment;
  if (updates.pipeline !== undefined) {
    // Sync steps back to DB
    for (const [key, step] of Object.entries(updates.pipeline)) {
      updateStep(id, key, {
        status: step.status as DbPipelineStep["status"],
        started_at: step.startedAt,
        completed_at: step.completedAt,
        note: step.note,
      });
    }
  }
  const updated = dbUpdateWork(id, dbUpdates);
  if (!updated) return undefined;
  return dbWorkToWork(updated);
}

export async function deleteWork(id: string): Promise<boolean> {
  await maybeMigrateLegacy();
  const ok = dbDeleteWork(id);
  if (!ok) return false;
  try {
    await rm(workDir(id), { recursive: true, force: true });
  } catch {
    // directory may already be gone
  }
  return true;
}

/** Recursively list files in assets/ and output/ dirs, returning relative paths. */
export async function listAssets(id: string): Promise<string[]> {
  const results: string[] = [];
  const baseDir = workDir(id);

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          results.push(relative(baseDir, fullPath).replace(/\\/g, "/"));
        }
      }
    } catch {
      // directory may not exist yet
    }
  }

  await walk(join(baseDir, "assets"));
  await walk(join(baseDir, "output"));

  return results;
}

export function getAssetPath(id: string, filename: string): string {
  return join(workDir(id), filename);
}

/** Save execution history for a pipeline step. */
export async function saveStepHistory(id: string, stepKey: string, data: unknown): Promise<void> {
  const stepsDir = join(workDir(id), "steps");
  await mkdir(stepsDir, { recursive: true });
  await writeFile(join(stepsDir, `${stepKey}.json`), JSON.stringify(data, null, 2), "utf-8");
}

/** Load execution history for a pipeline step. */
export async function loadStepHistory(id: string, stepKey: string): Promise<unknown | null> {
  try {
    const raw = await readFile(join(workDir(id), "steps", `${stepKey}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Save full conversation to chat.json (single file per work). */
export async function saveWorkChat(id: string, data: unknown): Promise<void> {
  await writeFile(join(workDir(id), "chat.json"), JSON.stringify(data), "utf-8");
}

/** Load full conversation from chat.json. */
export async function loadWorkChat(id: string): Promise<unknown | null> {
  try {
    const raw = await readFile(join(workDir(id), "chat.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Evaluation results ──────────────────────────────────────────────────────

export interface EvalResult {
  step: string;
  attempt: number;
  verdict: "pass" | "fail";
  scores: Record<string, number>;
  issues: Array<{ severity: "critical" | "major" | "minor"; description: string; file?: string }>;
  suggestions: string[];
  timestamp: string;
}

export async function saveEvalResult(id: string, step: string, attempt: number, result: EvalResult): Promise<void> {
  const dir = workDir(id);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `eval-${step}-${attempt}.json`);
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
}

export async function loadEvalResult(id: string, step: string, attempt: number): Promise<EvalResult | null> {
  try {
    const filePath = join(workDir(id), `eval-${step}-${attempt}.json`);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as EvalResult;
  } catch {
    return null;
  }
}

export async function loadAllEvalResults(id: string, step: string): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (let i = 1; i <= 10; i++) {
    const r = await loadEvalResult(id, step, i);
    if (r) results.push(r);
    else break;
  }
  return results;
}

// ── Status derivation (single source of truth for works.status) ─────────────

/**
 * works.status 的数值排序（用于"只允许向前修复"的对账判断）。
 * published/failed 为终态，派生逻辑永不覆盖。
 */
const STATUS_ORDER: Record<WorkStatus, number> = {
  draft: 0,
  researching: 1,
  planning: 2,
  assetting: 3,
  assembling: 4,
  reviewing: 5,
  published: 6,
  failed: 6,
};

/** 流水线 step key → works.status（material-search 归入 researching） */
const STEP_TO_STATUS: Record<string, WorkStatus> = {
  "material-search": "researching",
  research: "researching",
  plan: "planning",
  assets: "assetting",
  assembly: "assembling",
};

export function statusOrder(s: WorkStatus): number {
  return STATUS_ORDER[s] ?? 0;
}

/**
 * 从流水线步骤状态推导 works.status。
 * 规则：
 * - published / failed 是终态，永远保持不变；
 * - 全部步骤 done/skipped → reviewing（成品待审核）；
 * - 第一个 active/evaluating/eval_blocked 步骤决定状态（素材搜索归 researching）；
 * - 全部 pending → 保持当前状态（通常为 draft）。
 */
export function deriveStatusFromPipeline(
  pipeline: Record<string, PipelineStep>,
  current: WorkStatus,
): WorkStatus {
  if (current === "published" || current === "failed") return current;
  const steps = Object.entries(pipeline);
  if (steps.length === 0) return current;

  const isFinished = (s: PipelineStep) => s.status === "done" || s.status === "skipped";
  if (steps.every(([, s]) => isFinished(s))) return "reviewing";

  const activeEntry = steps.find(
    ([, s]) => s.status === "active" || s.status === "evaluating" || s.status === "eval_blocked",
  );
  if (activeEntry) return STEP_TO_STATUS[activeEntry[0]] ?? current;

  return current;
}

