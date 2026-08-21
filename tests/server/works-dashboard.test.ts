import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createMetric } from "../../src/db/platform-metrics-repo.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { analyticsRoutes } from "../../src/server/routes/analytics.js";

function setupApp() {
  const app = new Hono();
  app.route("/api/analytics", analyticsRoutes);
  return app;
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function seed() {
  const now = new Date(NOW).toISOString();
  createAccount({
    id: "acc1", name: "抖音主号", platform: "douyin",
    tone_profile: {}, status: "active", created_at: now, updated_at: now,
  });
  createAccount({
    id: "acc2", name: "小红书号", platform: "xiaohongshu",
    tone_profile: {}, status: "active", created_at: now, updated_at: now,
  });
  createWork(
    {
      id: "w_dash",
      title: "聚合测试作品",
      type: "short-video",
      topic_category: "情感",
      status: "published",
      platforms: ["douyin", "xiaohongshu"],
      evaluation_mode: false,
      tags: [],
      created_at: now,
      updated_at: now,
    },
    []
  );
  // 两条 published 记录 + 一条 reviewing 记录(无指标)
  const r1 = createPublishRecord({
    work_id: "w_dash", platform: "douyin", account_id: "acc1",
    status: "published", published_at: iso(2 * DAY),
  });
  const r2 = createPublishRecord({
    work_id: "w_dash", platform: "xiaohongshu", account_id: "acc2",
    status: "published", published_at: iso(1 * DAY),
  });
  const r3 = createPublishRecord({
    work_id: "w_dash", platform: "douyin", account_id: "acc1",
    status: "reviewing", published_at: iso(3 * HOUR),
  });
  // 每条 published 记录两次采集:最新值分别为 100 / 200
  createMetric({
    publish_record_id: r1.id, platform: "douyin", account_id: "acc1",
    metric_type: "work", collected_at: iso(26 * HOUR),
    views: 80, likes: 8, comments: 1, shares: 1, collects: 1, completion_rate: 0.4,
  });
  createMetric({
    publish_record_id: r1.id, platform: "douyin", account_id: "acc1",
    metric_type: "work", collected_at: iso(2 * HOUR),
    views: 100, likes: 10, comments: 2, shares: 2, collects: 2, completion_rate: 0.5,
  });
  createMetric({
    publish_record_id: r2.id, platform: "xiaohongshu", account_id: "acc2",
    metric_type: "work", collected_at: iso(25 * HOUR),
    views: 150, likes: 15, comments: 3, shares: 3, collects: 3,
  });
  createMetric({
    publish_record_id: r2.id, platform: "xiaohongshu", account_id: "acc2",
    metric_type: "work", collected_at: iso(1 * HOUR),
    views: 200, likes: 20, comments: 4, shares: 4, collects: 4,
  });
  return { r1, r2, r3 };
}

describe("works-dashboard — 作品一级分类聚合", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("①②⑤ 列表:totals 为各记录最新指标求和;records 带 accountName;reviewing 无指标 metrics=null 且不计入 totals", async () => {
    const { r3 } = seed();
    const res = await setupApp().request("/api/analytics/works-dashboard");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.works).toHaveLength(1);
    const work = data.works[0];
    expect(work.workId).toBe("w_dash");
    expect(work.title).toBe("聚合测试作品");
    expect(work.workType).toBe("short-video");
    expect(work.category).toBe("情感");
    // ① 最新值求和(100+200),不是采集次数求和(80+100+150+200=530)
    expect(work.totals.views).toBe(300);
    expect(work.totals.likes).toBe(30);
    expect(work.platforms.sort()).toEqual(["douyin", "xiaohongshu"]);
    // ② records 三行(含 reviewing),各带 accountName
    expect(work.records).toHaveLength(3);
    const byPlatform = new Map(work.records.map((r: { platform: string }) => [r.platform + r.status, r]));
    const recDy = byPlatform.get("douyinpublished") as { accountName: string; metrics: { views: number; completionRate: number } };
    const recXhs = byPlatform.get("xiaohongshupublished") as { accountName: string; metrics: { views: number } };
    expect(recDy.accountName).toBe("抖音主号");
    expect(recDy.metrics.views).toBe(100);
    expect(recDy.metrics.completionRate).toBe(0.5);
    expect(recXhs.accountName).toBe("小红书号");
    expect(recXhs.metrics.views).toBe(200);
    // ⑤ reviewing 记录 metrics=null,且 totals 不含它(300 已隐含)
    const recReviewing = work.records.find((r: { recordId: number }) => r.recordId === r3.id);
    expect(recReviewing.status).toBe("reviewing");
    expect(recReviewing.metrics).toBeNull();
  });

  it("③ platform=douyin 过滤后 totals.views=100,records 只剩抖音行", async () => {
    seed();
    const res = await setupApp().request("/api/analytics/works-dashboard?platform=douyin");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.works).toHaveLength(1);
    const work = data.works[0];
    expect(work.totals.views).toBe(100);
    expect(work.platforms).toEqual(["douyin"]);
    expect(work.records).toHaveLength(2); // published + reviewing
    expect(work.records.every((r: { platform: string }) => r.platform === "douyin")).toBe(true);
  });

  // 2026-08-21 终审顺手项:date-only 的 to(如 2026-08-19)此前按 00:00:00 比较,
  // 当天发布的记录全部被排除;date-only to 应视为当天结束(含当天记录)
  it("from/to 过滤:date-only 的 to 含当天记录", async () => {
    const { r1 } = seed();
    // r1 published_at = iso(2*DAY),取当天日期;from=to=同一天 → 只应命中 r1
    const day = iso(2 * DAY).slice(0, 10);
    const res = await setupApp().request(`/api/analytics/works-dashboard?from=${day}&to=${day}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.works).toHaveLength(1);
    expect(data.works[0].records).toHaveLength(1);
    expect(data.works[0].records[0].recordId).toBe(r1.id);
  });

  it("accountId 过滤:只保留该账号的记录", async () => {
    seed();
    const res = await setupApp().request("/api/analytics/works-dashboard?accountId=acc2");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.works).toHaveLength(1);
    const work = data.works[0];
    expect(work.totals.views).toBe(200);
    expect(work.records).toHaveLength(1);
    expect(work.records[0].accountName).toBe("小红书号");
  });

  it("④ 详情:单作品 + 近 7 天按记录的采集序列,每个 recordId 两条点且按 collectedAt 升序", async () => {
    const { r1, r2 } = seed();
    const res = await setupApp().request("/api/analytics/works-dashboard/w_dash");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workId).toBe("w_dash");
    expect(data.totals.views).toBe(300);
    expect(data.records).toHaveLength(3);
    const seriesByRecord = new Map(
      (data.series as Array<{ recordId: number; points: Array<{ collectedAt: string; views: number }> }>)
        .map((s) => [s.recordId, s.points])
    );
    const p1 = seriesByRecord.get(r1.id)!;
    const p2 = seriesByRecord.get(r2.id)!;
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(2);
    expect(p1.map((p) => p.views)).toEqual([80, 100]);
    expect(p2.map((p) => p.views)).toEqual([150, 200]);
    // 升序
    expect(p1[0].collectedAt < p1[1].collectedAt).toBe(true);
    // reviewing 记录无采集 → 序列中无该 recordId 或 points 为空
    const all = data.series as Array<{ recordId: number; points: unknown[] }>;
    const reviewingSeries = all.find((s) => !seriesByRecord.has(s.recordId));
    if (reviewingSeries) expect(reviewingSeries.points).toHaveLength(0);
  });

  it("详情:7 天前的采集点不进序列,但仍计入 totals(最新值)", async () => {
    const now = new Date(NOW).toISOString();
    createAccount({
      id: "acc1", name: "抖音主号", platform: "douyin",
      tone_profile: {}, status: "active", created_at: now, updated_at: now,
    });
    createWork(
      {
        id: "w_old", title: "旧采集作品", type: "short-video", status: "published",
        platforms: ["douyin"], evaluation_mode: false, tags: [],
        created_at: now, updated_at: now,
      },
      []
    );
    const r = createPublishRecord({
      work_id: "w_old", platform: "douyin", account_id: "acc1",
      status: "published", published_at: iso(10 * DAY),
    });
    createMetric({
      publish_record_id: r.id, platform: "douyin", metric_type: "work",
      collected_at: iso(9 * DAY), views: 500,
    });
    const res = await setupApp().request("/api/analytics/works-dashboard/w_old");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totals.views).toBe(500);
    expect(data.series).toHaveLength(0);
  });

  it("详情:不存在的作品返回 404", async () => {
    const res = await setupApp().request("/api/analytics/works-dashboard/w_missing");
    expect(res.status).toBe(404);
  });
});
