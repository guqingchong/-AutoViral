import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createMetric, getLatestMetricByRecord, listLatestWorkMetrics } from "../../src/db/platform-metrics-repo.js";

describe("platform-metrics-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("stores and retrieves latest metric for a record", () => {
    const record = createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    createMetric({ publish_record_id: record.id, platform: "douyin", metric_type: "work", collected_at: "2026-07-01T00:00:00Z", views: 100, raw_data: {} });
    createMetric({ publish_record_id: record.id, platform: "douyin", metric_type: "work", collected_at: "2026-07-02T00:00:00Z", views: 200, raw_data: {} });
    const latest = getLatestMetricByRecord(record.id);
    expect(latest?.views).toBe(200);
  });

  it("lists latest work metrics", () => {
    const r1 = createPublishRecord({ work_id: "w1", platform: "douyin", status: "published" });
    const r2 = createPublishRecord({ work_id: "w2", platform: "bilibili", status: "published" });
    createMetric({ publish_record_id: r1.id, platform: "douyin", metric_type: "work", collected_at: new Date().toISOString(), views: 1, raw_data: {} });
    createMetric({ publish_record_id: r2.id, platform: "bilibili", metric_type: "work", collected_at: new Date().toISOString(), views: 2, raw_data: {} });
    expect(listLatestWorkMetrics().length).toBe(2);
  });
});
