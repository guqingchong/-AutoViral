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

import { getLatestBaseline } from "../db/baselines-repo.js";
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
