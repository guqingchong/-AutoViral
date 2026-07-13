import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createMetric } from "../../src/db/platform-metrics-repo.js";
import { createBaseline } from "../../src/db/baselines-repo.js";
import { analyzeWork, isHit, isFailure, computeBaseline } from "../../src/services/hit-failure-analysis.js";

describe("hit-failure-analysis", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => closeDb());

  it("classifies a hit when views exceed 3x baseline", () => {
    createBaseline({ metric_name: "work_performance", platform: "douyin", value_json: { views: 100, likes: 10, comments: 3, shares: 2 }, sample_count: 10, computed_at: new Date().toISOString() });
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", platform_post_id: "p1", status: "published" });
    createMetric({ publish_record_id: record.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 400, likes: 50, raw_data: {} });

    const analysis = analyzeWork(record.id);
    expect(analysis?.verdict).toBe("hit");
    expect(isHit(record.id)).toBe(true);
  });

  it("classifies a failure when views are below 0.3x baseline", () => {
    createBaseline({ metric_name: "work_performance", platform: "douyin", value_json: { views: 100, likes: 10, comments: 3, shares: 2 }, sample_count: 10, computed_at: new Date().toISOString() });
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", platform_post_id: "p1", status: "published" });
    createMetric({ publish_record_id: record.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 10, likes: 1, raw_data: {} });

    const analysis = analyzeWork(record.id);
    expect(analysis?.verdict).toBe("failure");
    expect(isFailure(record.id)).toBe(true);
  });

  it("returns normal for in-range performance", () => {
    createBaseline({ metric_name: "work_performance", platform: "douyin", value_json: { views: 100, likes: 10, comments: 3, shares: 2 }, sample_count: 10, computed_at: new Date().toISOString() });
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", platform_post_id: "p1", status: "published" });
    createMetric({ publish_record_id: record.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 150, likes: 15, raw_data: {} });

    const analysis = analyzeWork(record.id);
    expect(analysis?.verdict).toBe("normal");
  });

  it("computes baseline from latest work metrics", () => {
    const r1 = createPublishRecord({ work_id: "w1", platform: "douyin", platform_post_id: "p1", status: "published" });
    const r2 = createPublishRecord({ work_id: "w2", platform: "douyin", platform_post_id: "p2", status: "published" });
    createMetric({ publish_record_id: r1.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 100, likes: 10, raw_data: {} });
    createMetric({ publish_record_id: r2.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 300, likes: 30, raw_data: {} });

    const baseline = computeBaseline("douyin", "work_performance");
    expect(baseline).toBeDefined();
    expect(baseline?.sample_count).toBe(2);
    expect(baseline?.value_json.views).toBe(200);
  });
});
