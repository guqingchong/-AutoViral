import { Hono } from "hono";
import { listPublishRecords } from "../../db/publish-records-repo.js";
import {
  listLatestWorkMetrics,
  listMetricsByRecord,
  getLatestAccountMetric,
} from "../../db/platform-metrics-repo.js";
import { getEvalResultByWorkId } from "../../db/eval-results-repo.js";
import { listWorks } from "../../db/works-repo.js";
import {
  analyzeWorks,
  recomputeBaselines,
  type WorkAnalysisInput,
} from "../../services/hit-failure-analysis.js";
import { triggerManualCollection } from "../../services/analytics-scheduler.js";
import { getConfig } from "../../config.js";

const analyticsRoutes = new Hono();

analyticsRoutes.get("/records", (c) => {
  const records = listPublishRecords();
  return c.json({ records });
});

analyticsRoutes.get("/records/:id/metrics", (c) => {
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMetricsByRecord(id));
});

analyticsRoutes.get("/accounts/:platform", (c) => {
  const platform = c.req.param("platform");
  const metric = getLatestAccountMetric(platform);
  return c.json(metric ?? null);
});

analyticsRoutes.get("/works", (c) => {
  const platform = c.req.query("platform");
  const records = listPublishRecords(platform ? { platform } : undefined);
  const metricByRecord = new Map(
    listLatestWorkMetrics({ platform }).map((m) => [m.publish_record_id!, m])
  );
  const enriched = records.map((r) => ({
    ...r,
    latestMetric: metricByRecord.get(r.id) ?? null,
  }));
  return c.json(enriched);
});

function buildWorksAnalysis(): WorkAnalysisInput[] {
  const works = listWorks();
  const records = listPublishRecords();
  const recordByWork = new Map(records.map((r) => [r.work_id, r]));
  const metricByRecord = new Map(
    listLatestWorkMetrics().map((m) => [m.publish_record_id!, m])
  );
  return works
    .map((work) => {
      const record = recordByWork.get(work.id);
      if (!record) return null;
      const metric = metricByRecord.get(record.id);
      const evalResult = getEvalResultByWorkId(work.id);
      const dimensions = evalResult?.dimensions ?? {};
      return {
        workId: work.id,
        title: work.title ?? "未命名",
        platform: record.platform,
        publishedAt: record.published_at,
        topicCategory: work.topic_category,
        emotion: work.emotion_type,
        hook: work.hook_type,
        templateId: work.template_id,
        tags: work.tags,
        review: evalResult
          ? {
              totalScore: evalResult.overall_score,
              topicQuality: (dimensions as Record<string, { score?: number }>).topicQuality?.score,
              copyQuality: (dimensions as Record<string, { score?: number }>).copyQuality?.score,
              digitalHumanQuality: (dimensions as Record<string, { score?: number }>).digitalHumanQuality?.score,
              visualQuality: (dimensions as Record<string, { score?: number }>).visualQuality?.score,
              audioQuality: (dimensions as Record<string, { score?: number }>).audioQuality?.score,
              viralPotential: (dimensions as Record<string, { score?: number }>).viralPotential?.score,
            }
          : undefined,
        metrics: {
          views: metric?.views,
          likes: metric?.likes,
          comments: metric?.comments,
          shares: metric?.shares,
          collects: metric?.collects,
          completionRate: metric?.completion_rate,
        },
      };
    })
    .filter(Boolean) as WorkAnalysisInput[];
}

analyticsRoutes.get("/insights", (c) => {
  const platform = c.req.query("platform");
  const works = buildWorksAnalysis().filter((w) => !platform || w.platform === platform);
  return c.json(analyzeWorks(works, platform));
});

analyticsRoutes.post("/recompute-baselines", (c) => {
  const platforms = getConfig().analytics.sources.map((s) => s.platform);
  recomputeBaselines(Array.from(new Set(platforms)));
  return c.json({ ok: true });
});

analyticsRoutes.post("/collect", async (c) => {
  const result = await triggerManualCollection(getConfig().analytics);
  return c.json(result);
});

export { analyticsRoutes };
