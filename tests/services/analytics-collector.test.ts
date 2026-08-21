import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { getLatestAccountMetric } from "../../src/db/platform-metrics-repo.js";
import { collectAll, getLatestCreatorData } from "../../src/analytics-collector.js";
import { registerAdapter, registerAdapterFactory, clearRegistry } from "../../src/services/platform-adapters/registry.js";
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

class MockWechatAdapter implements PlatformAdapter {
  readonly platform = "wechat";
  readonly label = "Mock Wechat";

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    return { followers: 88, collectedAt: new Date().toISOString(), rawData: { source: "mock" } };
  }

  async collectPostMetrics(): Promise<CollectedMetrics> {
    return { views: 300, likes: 10, collectedAt: new Date().toISOString(), rawData: { source: "mock" } };
  }

  async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    return { comments: [] };
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

  // 2026-08-21 终审 C1:adapter 工厂注册键 "wechat",账号/发布记录用 "wechat_mp" ——
  // 采集链必须归一两侧键,指标行 platform 统一写账号侧键,account_id 非 NULL
  it("wechat 别名:工厂注册 wechat + 账号 wechat_mp → 账号与作品指标落 account_id 非空、platform 写账号侧键", async () => {
    registerAdapterFactory("wechat", () => new MockWechatAdapter());
    const now = new Date().toISOString();
    createAccount({
      id: "acc_wx", name: "公众号", platform: "wechat_mp",
      tone_profile: {}, status: "active", created_at: now, updated_at: now,
    });
    createPublishRecord({
      work_id: "w_wx", platform: "wechat_mp", account_id: "acc_wx",
      platform_post_id: "p_wx", status: "published",
    });

    const result = await collectAll();
    expect(result.errors).toEqual([]);
    expect(result.accountMetricsCollected).toBe(1);
    expect(result.metricsCollected).toBe(1);

    const rows = getDb().prepare(
      "SELECT platform, account_id, metric_type FROM platform_metrics ORDER BY metric_type"
    ).all() as Array<{ platform: string; account_id: string | null; metric_type: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.platform).toBe("wechat_mp");
      expect(row.account_id).toBe("acc_wx");
    }
  });

  it("wechat 别名:无账号平台回落平台级采集,指标行 platform 归一到账号侧键 wechat_mp", async () => {
    registerAdapterFactory("wechat", () => new MockWechatAdapter());

    const result = await collectAll();
    expect(result.accountMetricsCollected).toBe(1);

    const row = getDb().prepare(
      "SELECT platform, account_id FROM platform_metrics WHERE metric_type = 'account'"
    ).get() as { platform: string; account_id: string | null };
    expect(row.platform).toBe("wechat_mp");
  });
});
