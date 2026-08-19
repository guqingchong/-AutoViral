/**
 * P3-T4 数据回流测试（2026-08-18）：三率计算 / 48h 门槛 / 品类×情绪权重。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AUTOVIRAL_DATA_DIR = mkdtempSync(join(tmpdir(), "feedback-loop-test-"));

import { migrate } from "../../src/db/migrate.js";
import { getDb } from "../../src/db/connection.js";
import { computeRates, collectFeedback, getTopicWeights, getTopicWeight, refreshPurposePerformance } from "../../src/services/feedback-loop.js";

function seedWorkWithMetrics(opts: {
  workId: string; publishedAt: string; category: string; emotion: string;
  views: number; likes: number; comments?: number; shares?: number; collects?: number; completion?: number;
}): void {
  const db = getDb();
  db.prepare(`INSERT INTO works (id, title, type, status, platforms, created_at, updated_at, topic_category, emotion_type)
              VALUES (?, ?, 'short-video', 'published', '[]', ?, ?, ?, ?)`)
    .run(opts.workId, opts.workId, opts.publishedAt, opts.publishedAt, opts.category, opts.emotion);
  const pr = db.prepare(`INSERT INTO publish_records (work_id, platform, status, published_at) VALUES (?, 'douyin', 'published', ?)`)
    .run(opts.workId, opts.publishedAt);
  // 2026-08-19:种子数据改用生产写入方的 metric_type='work'(analytics-scheduler 写实);
  // 此前测试写 'post' 与被测 SQL 同错,测试绿但生产链路是死的——测试必须模拟写入方而非被测方
  db.prepare(`INSERT INTO platform_metrics (publish_record_id, platform, metric_type, collected_at, views, likes, comments, shares, collects, completion_rate, raw_data)
              VALUES (?, 'douyin', 'work', ?, ?, ?, ?, ?, ?, ?, '{}')`)
    .run(pr.lastInsertRowid, opts.publishedAt, opts.views, opts.likes, opts.comments ?? 0, opts.shares ?? 0, opts.collects ?? 0, opts.completion ?? null);
}

beforeAll(() => {
  migrate();
  // 两个同品类组合(样本≥2 才出权重) + 一个跨品类 + 一个未满 48h(应被跳过)
  seedWorkWithMetrics({ workId: "w_a", publishedAt: "2020-01-01T00:00:00Z", category: "城投", emotion: "信息价值", views: 10000, likes: 500, comments: 50, shares: 100, collects: 150, completion: 0.4 });
  seedWorkWithMetrics({ workId: "w_b", publishedAt: "2020-01-02T00:00:00Z", category: "城投", emotion: "信息价值", views: 20000, likes: 1400, comments: 100, shares: 200, collects: 300, completion: 0.5 });
  seedWorkWithMetrics({ workId: "w_c", publishedAt: "2020-01-03T00:00:00Z", category: "娱乐", emotion: "搞笑", views: 50000, likes: 500, comments: 20, shares: 10, collects: 10 });
  seedWorkWithMetrics({ workId: "w_new", publishedAt: new Date().toISOString(), category: "城投", emotion: "信息价值", views: 99999, likes: 9999 });
});

describe("feedback-loop", () => {
  it("computeRates:三率按 views 归一;views=0 返回 null", () => {
    expect(computeRates({ views: 1000, likes: 100, comments: 10, shares: 10, collects: 10 }))
      .toEqual({ likeRate: 0.1, interactionRate: 0.13, completionRate: undefined });
    expect(computeRates({ views: 0, likes: 5 })).toBeNull();
  });

  it("collectFeedback:满 48h 入库,未满 48h 跳过", () => {
    const r = collectFeedback();
    expect(r.processed).toBe(3);
    const rows = getDb().prepare(`SELECT work_id FROM topic_scores ORDER BY work_id`).all() as { work_id: string }[];
    expect(rows.map((x) => x.work_id)).toEqual(["w_a", "w_b", "w_c"]);
  });

  it("权重:高互动组合 weight>1,低互动<1,样本不足恒 1", () => {
    const weights = getTopicWeights();
    const cheng = weights.find((w) => w.category === "城投");
    const yule = weights.find((w) => w.category === "娱乐");
    // 城投互动率 (0.08+0.10)/2=0.09,娱乐 0.0108;全局均值≈0.057 → 城投>1,娱乐<1
    expect(cheng!.weight).toBeGreaterThan(1);
    expect(yule!.weight).toBeLessThan(1);
    expect(getTopicWeight("城投", "信息价值")).toBe(cheng!.weight);
    expect(getTopicWeight("不存在品类")).toBe(1);
  });

  // 2026-08-19 m9:三率按用途聚合反哺 purpose_skills 权重
  it("refreshPurposePerformance:高表现用途技能权重上浮,低表现下浮,留痕 purpose_performance", () => {
    const db = getDb();
    // 给已入库的 topic_scores 作品标用途:w_a/w_b(高互动)→ authority;w_c(低互动)→ short_drama
    db.prepare("UPDATE works SET purpose = 'authority' WHERE id IN ('w_a','w_b')").run();
    db.prepare("UPDATE works SET purpose = 'short_drama' WHERE id = 'w_c'").run();
    db.prepare("INSERT INTO purpose_skills (purpose, skill, weight) VALUES ('authority','钩子公式A',1.0),('short_drama','反转公式B',1.0)").run();

    const n = refreshPurposePerformance();
    expect(n).toBe(2);
    const authW = db.prepare("SELECT weight FROM purpose_skills WHERE purpose='authority'").get() as { weight: number };
    const dramaW = db.prepare("SELECT weight FROM purpose_skills WHERE purpose='short_drama'").get() as { weight: number };
    expect(authW.weight).toBeGreaterThan(1.0);   // 城投互动率高于全局 → 上浮
    expect(dramaW.weight).toBeLessThan(1.0);     // 娱乐低于全局 → 下浮
    const perf = db.prepare("SELECT purpose, factor, samples FROM purpose_performance ORDER BY purpose").all() as any[];
    expect(perf).toHaveLength(2);
    expect(perf.find((p) => p.purpose === "authority")?.factor).toBeGreaterThan(1);
  });
});
