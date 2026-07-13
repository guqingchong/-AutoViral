import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { getLatestAccountMetric } from "../../src/db/platform-metrics-repo.js";
import { collectAll, getLatestCreatorData } from "../../src/analytics-collector.js";
import { registerAdapter, clearRegistry } from "../../src/services/platform-adapters/registry.js";
import type { PlatformAdapter, CollectedMetrics, CollectedComment, ReplyResult } from "../../src/services/platform-adapters/types.js";

class MockCollectorAdapter implements PlatformAdapter {
  readonly platform = "mock";
  readonly label = "Mock";

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    return { followers: 1234, collectedAt: new Date().toISOString(), rawData: { source: "mock" } };
  }

  async collectPostMetrics(): Promise<CollectedMetrics> {
    return { views: 5000, likes: 200, comments: 30, shares: 10, collectedAt: new Date().toISOString(), rawData: { source: "mock" } };
  }

  async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    return {
      comments: [
        { externalCommentId: "c1", content: "不错", isReply: false, collectedAt: new Date().toISOString() },
      ],
    };
  }

  async publishReply(): Promise<ReplyResult> {
    return { success: true };
  }
}

describe("analytics-collector", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    clearRegistry();
  });

  afterEach(() => {
    closeDb();
    clearRegistry();
  });

  it("collects account metrics and work metrics", async () => {
    registerAdapter(new MockCollectorAdapter());
    createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });

    const result = await collectAll();
    expect(result.accountMetricsCollected).toBe(1);
    expect(result.metricsCollected).toBe(1);
    expect(result.commentsCollected).toBe(1);
    expect(result.errors.length).toBe(0);

    const account = getLatestAccountMetric("mock");
    expect(account?.followers).toBe(1234);
  });

  it("limits collection to specified platforms", async () => {
    registerAdapter(new MockCollectorAdapter());
    createPublishRecord({ work_id: "w1", platform: "mock", platform_post_id: "p1", status: "published" });

    const result = await collectAll(["other"]);
    expect(result.accountMetricsCollected).toBe(0);
    expect(result.metricsCollected).toBe(0);
  });

  it("reports errors for missing adapters", async () => {
    const result = await collectAll(["missing"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("No adapter registered");
  });

  it("retrieves latest creator data", async () => {
    registerAdapter(new MockCollectorAdapter());
    await collectAll();

    const data = getLatestCreatorData("mock");
    expect(data?.followers).toBe(1234);
  });
});
