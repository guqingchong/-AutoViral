/**
 * Hit/Failure analysis service.
 *
 * Compares work performance against baselines to classify:
 * - "hit": significantly outperforms baseline (3x views OR 2x likes)
 * - "failure": significantly underperforms (< 0.3x views OR < 0.2x likes)
 * - "normal": within expected range
 *
 * Hits trigger topic/prompt reinforcement; failures trigger analysis and correction.
 */

import { getLatestBaseline, createBaseline } from "../db/baselines-repo.js";
import { getLatestMetricByRecord, listLatestWorkMetrics } from "../db/platform-metrics-repo.js";
import { getPublishRecord } from "../db/publish-records-repo.js";
import type { DbBaseline } from "../db/types.js";

export type PerformanceVerdict = "hit" | "failure" | "normal";

export interface WorkAnalysis {
  publishRecordId: number;
  verdict: PerformanceVerdict;
  viewsRatio: number;
  likesRatio: number;
  baselines: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
  };
  actual: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
  };
}

/** Extended work input for multi-work hit/failure pattern mining. */
export interface WorkAnalysisInput {
  workId: string;
  title: string;
  platform: string;
  publishedAt?: string;
  duration?: number;
  topicCategory?: string;
  emotion?: string;
  hook?: string;
  templateId?: string;
  tags?: string[];
  review?: {
    totalScore?: number;
    topicQuality?: number;
    copyQuality?: number;
    digitalHumanQuality?: number;
    visualQuality?: number;
    audioQuality?: number;
    viralPotential?: number;
  };
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    collects?: number;
    completionRate?: number;
  };
}

export interface AnalysisInsight {
  dimension: string;
  value: string;
  sampleCount: number;
  avgViews: number;
  avgLikes: number;
  hitCount: number;
  failureCount: number;
  hitRate: number;
  failureRate: number;
  suggestion: string;
}

export interface HitFailureResult {
  hits: WorkAnalysisInput[];
  failures: WorkAnalysisInput[];
  insights: AnalysisInsight[];
  baselines: Record<string, number>;
}

const HIT_VIEWS_MULTIPLIER = 3;
const HIT_LIKES_MULTIPLIER = 2;
const FAILURE_VIEWS_THRESHOLD = 0.3;
const FAILURE_LIKES_THRESHOLD = 0.2;

export function analyzeWork(publishRecordId: number): WorkAnalysis | undefined {
  const record = getPublishRecord(publishRecordId);
  if (!record) return undefined;

  const metrics = getLatestMetricByRecord(publishRecordId);
  if (!metrics) return undefined;

  const baseline = getLatestBaseline("work_performance", record.platform);
  const defaults = { views: 100, likes: 10, comments: 3, shares: 2 };

  const baseValues = baseline
    ? (baseline.value_json as unknown as typeof defaults)
    : defaults;

  const actual = {
    views: metrics.views ?? 0,
    likes: metrics.likes ?? 0,
    comments: metrics.comments ?? 0,
    shares: metrics.shares ?? 0,
  };

  const baselines = {
    views: baseValues.views ?? defaults.views,
    likes: baseValues.likes ?? defaults.likes,
    comments: baseValues.comments ?? defaults.comments,
    shares: baseValues.shares ?? defaults.shares,
  };

  // Avoid division by zero
  const viewsRatio = baselines.views > 0 ? actual.views / baselines.views : 1;
  const likesRatio = baselines.likes > 0 ? actual.likes / baselines.likes : 1;

  let verdict: PerformanceVerdict = "normal";
  if (viewsRatio >= HIT_VIEWS_MULTIPLIER || likesRatio >= HIT_LIKES_MULTIPLIER) {
    verdict = "hit";
  } else if (viewsRatio < FAILURE_VIEWS_THRESHOLD || likesRatio < FAILURE_LIKES_THRESHOLD) {
    verdict = "failure";
  }

  return { publishRecordId, verdict, viewsRatio, likesRatio, baselines, actual };
}

/**
 * Check if the work is a "hit" — significantly outperforms baseline.
 */
export function isHit(publishRecordId: number): boolean {
  return analyzeWork(publishRecordId)?.verdict === "hit";
}

/**
 * Check if the work is a "failure" — significantly underperforms baseline.
 */
export function isFailure(publishRecordId: number): boolean {
  return analyzeWork(publishRecordId)?.verdict === "failure";
}

/**
 * Compute a new baseline from recent performance data.
 * Called periodically (e.g. weekly) by the analytics scheduler.
 */
export function computeBaseline(
  platform: string,
  metricName: string
): DbBaseline | undefined {
  // Get all latest work metrics for this platform
  const allMetrics = listLatestWorkMetrics({ platform, limit: 100 });

  if (allMetrics.length === 0) return undefined;

  const avg = (vals: (number | undefined)[]) => {
    const nums = vals.filter((v): v is number => v !== undefined && v > 0);
    return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
  };

  const value = {
    views: avg(allMetrics.map((m) => m.views)),
    likes: avg(allMetrics.map((m) => m.likes)),
    comments: avg(allMetrics.map((m) => m.comments)),
    shares: avg(allMetrics.map((m) => m.shares)),
  };

  return {
    id: 0, // placeholder, assigned by createBaseline
    metric_name: metricName,
    platform,
    value_json: value as unknown as Record<string, unknown>,
    sample_count: allMetrics.length,
    computed_at: new Date().toISOString(),
  };
}

function getBaselines(platform?: string): Record<string, number> {
  const avgViews = (getLatestBaseline("avg_views", platform)?.value_json.value as number) ?? 1000;
  const avgLikes = (getLatestBaseline("avg_likes", platform)?.value_json.value as number) ?? 50;
  return { avgViews, avgLikes };
}

/**
 * Analyze a batch of works to find hit/failure patterns across dimensions.
 * Used by the analytics dashboard insight endpoints.
 */
export function analyzeWorks(works: WorkAnalysisInput[], platform?: string): HitFailureResult {
  const baselines = getBaselines(platform);
  const hits = works.filter((w) => (w.metrics.views ?? 0) >= baselines.avgViews * 3 && (w.metrics.likes ?? 0) >= baselines.avgLikes * 2);
  const failures = works.filter((w) => (w.metrics.views ?? 0) < baselines.avgViews * 0.3 || (w.metrics.likes ?? 0) < baselines.avgLikes * 0.2);

  const dimensions: { key: keyof WorkAnalysisInput; label: string }[] = [
    { key: "topicCategory", label: "选题" },
    { key: "emotion", label: "情绪" },
    { key: "hook", label: "钩子" },
    { key: "templateId", label: "模板" },
  ];

  const hourGroups = new Map<string, WorkAnalysisInput[]>();
  for (const w of works) {
    if (!w.publishedAt) continue;
    const hour = new Date(w.publishedAt).getHours();
    const bucket = `${hour}:00`;
    const list = hourGroups.get(bucket) ?? [];
    list.push(w);
    hourGroups.set(bucket, list);
  }

  const insights: AnalysisInsight[] = [];

  for (const { key, label } of dimensions) {
    const groups = new Map<string, WorkAnalysisInput[]>();
    for (const w of works) {
      const value = w[key] as string | undefined;
      if (!value) continue;
      const list = groups.get(value) ?? [];
      list.push(w);
      groups.set(value, list);
    }
    for (const [value, list] of groups) {
      if (list.length < 3) continue;
      const avgViews = list.reduce((s, w) => s + (w.metrics.views ?? 0), 0) / list.length;
      const avgLikes = list.reduce((s, w) => s + (w.metrics.likes ?? 0), 0) / list.length;
      const hitCount = list.filter((w) => hits.includes(w)).length;
      const failureCount = list.filter((w) => failures.includes(w)).length;
      insights.push({
        dimension: label,
        value,
        sampleCount: list.length,
        avgViews: Math.round(avgViews),
        avgLikes: Math.round(avgLikes),
        hitCount,
        failureCount,
        hitRate: hitCount / list.length,
        failureRate: failureCount / list.length,
        suggestion: hitCount > failureCount
          ? `${label}「${value}」表现较好，建议继续使用。`
          : `${label}「${value}」表现较差，建议减少使用或调整。`,
      });
    }
  }

  for (const [value, list] of hourGroups) {
    if (list.length < 3) continue;
    const avgViews = list.reduce((s, w) => s + (w.metrics.views ?? 0), 0) / list.length;
    const hitCount = list.filter((w) => hits.includes(w)).length;
    insights.push({
      dimension: "发布时间",
      value,
      sampleCount: list.length,
      avgViews: Math.round(avgViews),
      avgLikes: 0,
      hitCount,
      failureCount: list.length - hitCount,
      hitRate: hitCount / list.length,
      failureRate: (list.length - hitCount) / list.length,
      suggestion: hitCount / list.length > 0.3
        ? `${value} 发布作品更容易成为爆款。`
        : `避免在 ${value} 发布作品。`,
    });
  }

  return { hits, failures, insights, baselines };
}

/**
 * Recompute average views/likes baselines for the given platforms.
 * Persists the new baselines to the database.
 */
export function recomputeBaselines(platforms: string[]): void {
  const now = new Date().toISOString();
  for (const platform of platforms) {
    const metrics = listLatestWorkMetrics({ platform });
    if (!metrics.length) continue;
    const views = metrics.map((m) => m.views ?? 0);
    const likes = metrics.map((m) => m.likes ?? 0);
    createBaseline({
      metric_name: "avg_views",
      platform,
      value_json: { value: views.reduce((a, b) => a + b, 0) / views.length },
      sample_count: views.length,
      computed_at: now,
    });
    createBaseline({
      metric_name: "avg_likes",
      platform,
      value_json: { value: likes.reduce((a, b) => a + b, 0) / likes.length },
      sample_count: likes.length,
      computed_at: now,
    });
  }
}
