/**
 * B1 数据回流（2026-08-18 P3-T4）。
 *
 * 发布 48h 后的作品，从 platform_metrics 最新快照抓三率：
 *   完播率 completion_rate（平台直给）
 *   点赞率 like_rate = likes / views
 *   互动率 interaction_rate = (likes+comments+shares+collects) / views
 * 落到 topic_scores（作品级），再按 品类×情绪 聚合出选题权重（0.5~1.5 截断），
 * 供趋势打分 topicScore 做权重修正——表现好的品类×情绪组合在后续调研中加权。
 *
 * 调度：挂在 analytics-scheduler 每日基线任务里（见 startScheduler 调用点）。
 */

import { getDb } from "../db/connection.js";

export interface TopicScoreRow {
  workId: string;
  topicId?: number;
  category?: string;
  emotionType?: string;
  views: number;
  completionRate?: number;
  likeRate: number;
  interactionRate: number;
}

export interface TopicWeight {
  category: string;
  emotionType: string;
  samples: number;
  avgCompletion?: number;
  avgLikeRate: number;
  avgInteractionRate: number;
  /** 综合权重:以互动率为主轴归一,截断到 [0.5, 1.5] */
  weight: number;
}

/** 三率计算:views 为 0/缺失时返回 null(该条不入库) */
export function computeRates(m: {
  views?: number; likes?: number; comments?: number; shares?: number; collects?: number; completion_rate?: number;
}): { likeRate: number; interactionRate: number; completionRate?: number } | null {
  if (!m.views || m.views <= 0) return null;
  const likes = m.likes ?? 0;
  return {
    likeRate: likes / m.views,
    interactionRate: (likes + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0)) / m.views,
    completionRate: m.completion_rate,
  };
}

/** 主入口:发布满 48h 的 publish_records → 最新作品级指标 → 按作品跨平台跨账号汇总 → topic_scores
 *  (每作品每天一行,platform='all';幂等:同作品同日先删后插) */
export function collectFeedback(): { processed: number; skipped: number } {
  const db = getDb();
  // 2026-08-21 Task 10:按记录回流改为按作品聚合——
  // 内层取每条记录最新一条作品级指标(metric_type='work',同 Task 9 works-dashboard 写法),
  // 外层按 work_id 聚合:views/likes 等跨该作品全部 published 记录求和,三率按合计加权。
  // 历史教训:写入方(analytics-scheduler)用 metric_type='work',
  // 此处曾误写 'post'(类型系统里不存在该值)导致回流死链、topic_scores 永空
  const rows = db.prepare(`
    SELECT pr.work_id,
           MIN(w.topic_id) AS topic_id, MIN(w.topic_category) AS topic_category, MIN(w.emotion_type) AS emotion_type,
           SUM(pm.views) AS views, SUM(pm.likes) AS likes, SUM(pm.comments) AS comments,
           SUM(pm.shares) AS shares, SUM(pm.collects) AS collects,
           AVG(pm.completion_rate) AS completion_rate
    FROM publish_records pr
    JOIN works w ON w.id = pr.work_id
    JOIN platform_metrics pm ON pm.id = (
      SELECT id FROM platform_metrics WHERE publish_record_id = pr.id AND metric_type = 'work'
      ORDER BY collected_at DESC LIMIT 1
    )
    WHERE pr.status = 'published'
      AND pr.published_at IS NOT NULL
      AND datetime(pr.published_at) <= datetime('now', '-48 hours')
    GROUP BY pr.work_id
  `).all() as Array<Record<string, unknown>>;

  let processed = 0;
  let skipped = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const rates = computeRates({
      views: r.views as number, likes: r.likes as number, comments: r.comments as number,
      shares: r.shares as number, collects: r.collects as number,
      completion_rate: r.completion_rate as number | undefined,
    });
    if (!rates) { skipped++; continue; }
    const workId = r.work_id as string;
    db.prepare(`DELETE FROM topic_scores WHERE work_id = ? AND date(computed_at) = ? AND platform = 'all'`).run(workId, today);
    db.prepare(`
      INSERT INTO topic_scores (work_id, topic_id, category, emotion_type, views, completion_rate, like_rate, interaction_rate, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'all')
    `).run(
      workId, r.topic_id ?? null, r.topic_category ?? null, r.emotion_type ?? null,
      r.views ?? 0, rates.completionRate ?? null, rates.likeRate, rates.interactionRate,
    );
    processed++;
  }
  // 三率反哺(2026-08-19 补全 m9):有新数据时按用途聚合,调整用途技能包权重——
  // 表现高于全局的用途,其技能包权重上浮(排序前移);低于全局的下浮。
  // 乘法微调有界[0.5,2.0],保留调研命中(+0.1)带来的个技能差异
  if (processed > 0) refreshPurposePerformance();
  return { processed, skipped };
}

/** 按用途聚合作品三率 → 调整 purpose_skills.weight 并留痕 purpose_performance */
export function refreshPurposePerformance(): number {
  const db = getDb();
  // 2026-08-21 Task 10:只读跨平台汇总行(platform='all'),全局均值同理
  const globalRow = db.prepare(`SELECT AVG(interaction_rate) AS g FROM topic_scores WHERE platform = 'all'`).get() as { g: number | null };
  const g = globalRow.g && globalRow.g > 0 ? globalRow.g : 1;
  const rows = db.prepare(`
    SELECT w.purpose AS purpose, AVG(ts.interaction_rate) AS ai, COUNT(*) AS n
    FROM topic_scores ts JOIN works w ON w.id = ts.work_id
    WHERE w.purpose IS NOT NULL AND ts.platform = 'all'
    GROUP BY w.purpose
  `).all() as Array<{ purpose: string; ai: number | null; n: number }>;
  for (const r of rows) {
    const ai = r.ai ?? 0;
    const factor = Math.min(1.5, Math.max(0.5, ai / g));
    db.prepare(`
      INSERT INTO purpose_performance (purpose, factor, samples, avg_interaction, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(purpose) DO UPDATE SET factor=excluded.factor, samples=excluded.samples,
        avg_interaction=excluded.avg_interaction, updated_at=datetime('now')
    `).run(r.purpose, factor, r.n, ai);
    // factor 1.5→×1.25 / 1.0→×1.0 / 0.5→×0.75 的温和乘法调整
    const multiplier = 0.5 + factor / 2;
    db.prepare(`UPDATE purpose_skills SET weight = MAX(0.5, MIN(2.0, weight * ?)), updated_at = datetime('now') WHERE purpose = ?`)
      .run(multiplier, r.purpose);
  }
  return rows.length;
}

/** 品类×情绪 聚合权重。样本 <2 的组合不给权重(返回里 samples 供判断) */
export function getTopicWeights(): TopicWeight[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT category, emotion_type,
           COUNT(*) AS samples,
           AVG(completion_rate) AS avg_completion,
           AVG(like_rate) AS avg_like,
           AVG(interaction_rate) AS avg_interaction
    FROM topic_scores
    WHERE category IS NOT NULL AND platform = 'all'
    GROUP BY category, emotion_type
  `).all() as Array<Record<string, unknown>>;

  // 全局均值作归一基准;无数据时权重恒 1(同样只读 platform='all' 汇总行)
  const globalRow = db.prepare(`SELECT AVG(interaction_rate) AS g FROM topic_scores WHERE platform = 'all'`).get() as { g: number | null };
  const globalAvg = globalRow.g && globalRow.g > 0 ? globalRow.g : 1;

  return rows.map((r) => {
    const avgInteraction = (r.avg_interaction as number) ?? 0;
    const raw = avgInteraction / globalAvg;
    return {
      category: r.category as string,
      emotionType: (r.emotion_type as string) ?? "",
      samples: r.samples as number,
      avgCompletion: (r.avg_completion as number) ?? undefined,
      avgLikeRate: (r.avg_like as number) ?? 0,
      avgInteractionRate: avgInteraction,
      weight: Math.min(1.5, Math.max(0.5, raw)),
    };
  });
}

/** 选题打分权重查询:给 trend-research 的 topicScore 修正用;样本不足/无数据返回 1 */
export function getTopicWeight(category?: string, emotionType?: string): number {
  if (!category) return 1;
  const w = getTopicWeights().find((x) => x.category === category && (!emotionType || x.emotionType === emotionType));
  return w && w.samples >= 2 ? w.weight : 1;
}
