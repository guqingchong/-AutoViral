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

// ── works-dashboard:作品一级分类聚合(2026-08-20 重构,Task 9)─────────────
// 聚合语义:
// - 状态范围 pr.status IN ('published','reviewing')
// - 每条记录取"最新一条作品级指标"(pm.id = (SELECT ... LIMIT 1) 子查询形式,
//   不用 GROUP BY HAVING MAX —— 含 NULL 的 LEFT JOIN 会丢 reviewing 行)
// - totals = 各记录最新值求和(不是采集次数求和);无指标记录 metrics=null 且不计入 totals

interface DashboardRow {
  work_id: string;
  title: string | null;
  work_type: string | null;
  topic_category: string | null;
  record_id: number;
  platform: string;
  account_id: string | null;
  status: string;
  published_at: string | null;
  account_name: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  collects: number | null;
  completion_rate: number | null;
}

function queryWorkDashboardRows(filters: {
  platform?: string;
  accountId?: string;
  workId?: string;
  from?: string;
  to?: string;
}): DashboardRow[] {
  const db = getDb();
  const conds = ["pr.status IN ('published','reviewing')"];
  const params: unknown[] = [];
  if (filters.platform) { conds.push("pr.platform = ?"); params.push(filters.platform); }
  if (filters.accountId) { conds.push("pr.account_id = ?"); params.push(filters.accountId); }
  if (filters.workId) { conds.push("pr.work_id = ?"); params.push(filters.workId); }
  if (filters.from) { conds.push("pr.published_at >= ?"); params.push(filters.from); }
  if (filters.to) { conds.push("pr.published_at <= ?"); params.push(filters.to); }
  return db.prepare(`
    SELECT w.id AS work_id, w.title, w.type AS work_type, w.topic_category,
           pr.id AS record_id, pr.platform, pr.account_id, pr.status, pr.published_at,
           a.name AS account_name,
           pm.views, pm.likes, pm.comments, pm.shares, pm.collects, pm.completion_rate
    FROM publish_records pr
    JOIN works w ON w.id = pr.work_id
    LEFT JOIN accounts a ON a.id = pr.account_id
    LEFT JOIN platform_metrics pm ON pm.id = (
      SELECT id FROM platform_metrics WHERE publish_record_id = pr.id AND metric_type = 'work'
      ORDER BY collected_at DESC LIMIT 1
    )
    WHERE ${conds.join(" AND ")}
    ORDER BY pr.published_at DESC
  `).all(...params) as unknown as DashboardRow[];
}

// JS 侧按 work_id 分组:records 明细 + totals(最新值求和)
function aggregateWorkRows(rows: DashboardRow[]) {
  const byWork = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    const list = byWork.get(row.work_id) ?? [];
    list.push(row);
    byWork.set(row.work_id, list);
  }
  return Array.from(byWork.entries()).map(([workId, list]) => {
    const first = list[0];
    const records = list.map((r) => ({
      recordId: r.record_id,
      platform: r.platform,
      accountId: r.account_id ?? null,
      accountName: r.account_name ?? null,
      status: r.status,
      publishedAt: r.published_at ?? null,
      // 无指标行(LEFT JOIN 全 NULL,如 reviewing)→ metrics=null
      metrics: r.views == null && r.likes == null && r.comments == null
        && r.shares == null && r.collects == null && r.completion_rate == null
        ? null
        : {
            views: r.views ?? 0,
            likes: r.likes ?? 0,
            comments: r.comments ?? 0,
            shares: r.shares ?? 0,
            collects: r.collects ?? 0,
            completionRate: r.completion_rate ?? null,
          },
    }));
    const totals = { views: 0, likes: 0, comments: 0, shares: 0, collects: 0 };
    for (const rec of records) {
      if (!rec.metrics) continue;
      totals.views += rec.metrics.views;
      totals.likes += rec.metrics.likes;
      totals.comments += rec.metrics.comments;
      totals.shares += rec.metrics.shares;
      totals.collects += rec.metrics.collects;
    }
    const publishedAt = list
      .map((r) => r.published_at)
      .filter((v): v is string => v != null)
      .sort()
      .at(-1) ?? null;
    return {
      workId,
      title: first.title ?? "未命名",
      workType: first.work_type ?? null,
      category: first.topic_category ?? null,
      publishedAt,
      platforms: Array.from(new Set(list.map((r) => r.platform))),
      totals,
      records,
    };
  });
}

// GET /api/analytics/works-dashboard?platform=&accountId=&from=&to=
analyticsRoutes.get("/works-dashboard", (c) => {
  const rows = queryWorkDashboardRows({
    platform: c.req.query("platform"),
    accountId: c.req.query("accountId"),
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  return c.json({ works: aggregateWorkRows(rows) });
});

// GET /api/analytics/works-dashboard/:workId — 单作品明细 + 近 7 天按记录的采集序列
analyticsRoutes.get("/works-dashboard/:workId", (c) => {
  const workId = c.req.param("workId");
  const rows = queryWorkDashboardRows({ workId });
  const works = aggregateWorkRows(rows);
  const work = works[0];
  if (!work) {
    // 无符合状态的记录:作品本身存在也返回空明细,不存在则 404
    const exists = getDb().prepare("SELECT 1 FROM works WHERE id = ?").get(workId);
    if (!exists) return c.json({ error: "work not found" }, 404);
    return c.json({
      workId,
      title: null,
      workType: null,
      category: null,
      publishedAt: null,
      platforms: [],
      totals: { views: 0, likes: 0, comments: 0, shares: 0, collects: 0 },
      records: [],
      series: [],
    });
  }
  const recordIds = work.records.map((r) => r.recordId);
  const placeholders = recordIds.map(() => "?").join(",");
  const seriesRows = getDb().prepare(`
    SELECT publish_record_id, views, likes, comments, shares, collects, collected_at
    FROM platform_metrics
    WHERE publish_record_id IN (${placeholders}) AND metric_type = 'work'
      AND datetime(collected_at) >= datetime('now', '-7 days')
    ORDER BY collected_at ASC
  `).all(...recordIds) as Array<Record<string, unknown>>;
  const byRecord = new Map<number, Array<Record<string, unknown>>>();
  for (const row of seriesRows) {
    const rid = row.publish_record_id as number;
    const list = byRecord.get(rid) ?? [];
    list.push({
      collectedAt: row.collected_at,
      views: row.views ?? 0,
      likes: row.likes ?? 0,
      comments: row.comments ?? 0,
      shares: row.shares ?? 0,
      collects: row.collects ?? 0,
    });
    byRecord.set(rid, list);
  }
  const series = Array.from(byRecord.entries()).map(([recordId, points]) => ({ recordId, points }));
  return c.json({ ...work, series });
});

export { analyticsRoutes };
