import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { dataDir } from "../config.js";
import { createWork, updateWork, getWorkSteps, workExists } from "./works-repo.js";
import { fromJson } from "./json.js";
import type { DbWork, DbPipelineStep, DbWorkStatus } from "./types.js";

const LEGACY_INDEX = join(dataDir, "works", "works.yaml");

interface LegacySummary {
  id: string;
  title: string;
  type: DbWork["type"];
  contentCategory?: string;
  platforms?: string[];
  status: DbWork["status"];
  updatedAt: string;
}

interface LegacyStep {
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  note?: string;
}

interface LegacyWork {
  id: string;
  title: string;
  type: DbWork["type"];
  contentCategory?: string;
  videoSource?: string;
  videoSearchQuery?: string;
  status: DbWork["status"];
  platforms: string[];
  pipeline: Record<string, LegacyStep>;
  cliSessionId?: string;
  coverImage?: string;
  topicHint?: string;
  evaluationMode?: boolean;
  evalSessionIds?: Record<string, string>;
  evalAttempts?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

export async function migrateLegacyWorks(): Promise<number> {
  let index: { works: LegacySummary[] } = { works: [] };
  try {
    const raw = await readFile(LEGACY_INDEX, "utf-8");
    index = yaml.load(raw) as { works: LegacySummary[] };
  } catch {
    return 0;
  }

  let migrated = 0;
  for (const summary of index.works ?? []) {
    if (workExists(summary.id)) continue; // already in DB
    try {
      const raw = await readFile(join(dataDir, "works", summary.id, "work.yaml"), "utf-8");
      const legacy = yaml.load(raw) as LegacyWork;
      const work: DbWork = {
        id: legacy.id,
        title: legacy.title,
        type: legacy.type,
        content_category: legacy.contentCategory,
        video_source: legacy.videoSource,
        video_search_query: legacy.videoSearchQuery,
        status: legacy.status,
        platforms: legacy.platforms,
        evaluation_mode: legacy.evaluationMode ?? false,
        topic_hint: legacy.topicHint,
        cli_session_id: legacy.cliSessionId,
        eval_session_ids: legacy.evalSessionIds,
        eval_attempts: legacy.evalAttempts,
        tags: [],
        created_at: legacy.createdAt,
        updated_at: legacy.updatedAt,
      };
      const steps = Object.entries(legacy.pipeline).map(([key, s], idx) => ({
        work_id: work.id,
        step_key: key,
        name: s.name,
        status: s.status as DbPipelineStep["status"],
        started_at: s.startedAt,
        completed_at: s.completedAt,
        note: s.note,
        sort_order: idx,
      }));
      createWork(work, steps);
      migrated++;
    } catch {
      // skip unparseable legacy work
    }
  }
  return migrated;
}
