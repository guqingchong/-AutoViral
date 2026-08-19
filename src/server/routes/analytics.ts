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
import { getConfig, loadConfig } from "../../config.js";
import { getDb } from "../../db/connection.js";

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
  const workTitles = new Map(
    listWorks().map((w) => [w.id, w.title])
  );
  const enriched = records.map((r) => ({
    ...r,
    latestMetric: metricByRecord.get(r.id) ?? null,
    workTitle: workTitles.get(r.work_id) ?? r.work_id,
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

// GET /api/analytics/creator — 数据页 dashboard 数据源(2026-08-19 补全)。
// 此前端点不存在:前端 fetch 拿到 SPA 404 页面 → 永远停在"连接账号"。
// 返回:configured(有无账号源)+ 账号最新指标 + 已发布作品的最新三率 + 汇总 + 粉丝增量。
analyticsRoutes.get("/creator", async (c) => {
  const config = await loadConfig();
  const sources = config.analytics?.sources ?? [];
  const platform = c.req.query("platform") ?? sources[0]?.platform ?? "douyin";
  const source = sources.find((s) => s.platform === platform) ?? sources[0];
  if (!source?.accountUrl) return c.json({ configured: false });

  const db = getDb();
  // 账号指标:最新一条给当前值,次新算增量
  const accRows = db.prepare(
    `SELECT followers, raw_data, collected_at FROM platform_metrics
     WHERE platform = ? AND metric_type = 'account' ORDER BY collected_at DESC LIMIT 2`,
  ).all(platform) as Array<{ followers: number | null; raw_data: string; collected_at: string }>;
  const latest = accRows[0];
  const prev = accRows[1];

  // 作品指标:已发布记录 JOIN 最新作品级指标(每条记录取最新一次采集)
  const workRows = db.prepare(
    `SELECT pr.id AS record_id, pr.published_at, w.title,
            pm.views, pm.likes, pm.comments, pm.shares, pm.collects, pm.completion_rate, pm.collected_at
     FROM publish_records pr
     JOIN works w ON w.id = pr.work_id
     JOIN platform_metrics pm ON pm.publish_record_id = pr.id AND pm.metric_type = 'work'
     WHERE pr.platform = ? AND pr.status = 'published'
     GROUP BY pr.id
     HAVING MAX(pm.collected_at)
     ORDER BY pr.published_at DESC
     LIMIT 50`,
  ).all(platform) as Array<Record<string, unknown>>;

  const works = workRows.map((r) => ({
    desc: r.title,
    create_time: r.published_at,
    play_count: r.views ?? 0,
    digg_count: r.likes ?? 0,
    comment_count: r.comments ?? 0,
    share_count: r.shares ?? 0,
    collect_count: r.collects ?? 0,
  }));
  const n = works.length;
  const sum = (k: "play_count" | "digg_count" | "comment_count" | "share_count" | "collect_count") =>
    works.reduce((s, w) => s + (Number(w[k]) || 0), 0);
  const totalViews = sum("play_count");
  const totalInteractions = sum("digg_count") + sum("comment_count") + sum("share_count") + sum("collect_count");

  return c.json({
    configured: true,
    data: {
      platform,
      collected_at: latest?.collected_at ?? null,
      account: {
        nickname: "",
        follower_count: latest?.followers ?? 0,
        following_count: 0,
        total_favorited: 0,
        aweme_count: n,
      },
      works,
      summary: {
        total_works_collected: n,
        avg_play: n ? Math.round(totalViews / n) : 0,
        avg_digg: n ? Math.round(sum("digg_count") / n) : 0,
        avg_comment: n ? Math.round(sum("comment_count") / n) : 0,
        avg_share: n ? Math.round(sum("share_count") / n) : 0,
        avg_collect: n ? Math.round(sum("collect_count") / n) : 0,
        engagement_rate: totalViews > 0 ? totalInteractions / totalViews : 0,
      },
    },
    delta: {
      followers: latest && prev ? (latest.followers ?? 0) - (prev.followers ?? 0) : undefined,
    },
  });
});

export { analyticsRoutes };
