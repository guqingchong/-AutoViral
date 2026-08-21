/**
 * Task 8: 调度器按账号遍历 + 指标落 account_id
 *
 * ① 账号指标循环:两账号同平台 → 两行 account 指标,各带 account_id
 * ② 某账号 adapter 抛错 → 循环继续,其余账号正常落库
 * ③ 作品指标:publish_record 有 account_id → 用该账号 adapter 采
 * ④ account_id 为 NULL 的历史记录 → getAdapterForAccount(platform, undefined) 兜底
 * ⑤ collectAll({ accountId }) 只采该账号
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { cronCallbacks } = vi.hoisted(() => ({
  cronCallbacks: [] as Array<() => Promise<void>>,
}));

// 捕获 cron 回调直接调用,避免依赖真实定时器
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expr: string, cb: () => Promise<void>) => {
      cronCallbacks.push(cb);
      return { stop: vi.fn() };
    }),
  },
}));

// 隔离数据回流(选题权重)副作用
vi.mock("../../src/services/feedback-loop.js", () => ({
  collectFeedback: vi.fn(() => ({ processed: 0, skipped: 0 })),
}));

import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { createPublishRecord } from "../../src/db/publish-records-repo.js";
import { startScheduler, stopScheduler } from "../../src/services/analytics-scheduler.js";
import { collectAll } from "../../src/analytics-collector.js";
import { registerAdapterFactory, clearRegistry } from "../../src/services/platform-adapters/registry.js";
import type { PlatformAdapter, CollectedMetrics, CollectedComment, ReplyResult } from "../../src/services/platform-adapters/types.js";
import type { DbAccountStatus } from "../../src/db/types.js";

interface MockOptions {
  followers?: number;
  failAccount?: boolean;
  onPostMetrics?: () => void;
}

function makeAdapter(platform: string, opts: MockOptions = {}): PlatformAdapter {
  return {
    platform,
    label: `Mock ${platform}`,
    async collectAccountMetrics(): Promise<CollectedMetrics> {
      if (opts.failAccount) throw new Error("account采集失败");
      return { followers: opts.followers ?? 100, collectedAt: new Date().toISOString(), rawData: {} };
    },
    async collectPostMetrics(): Promise<CollectedMetrics> {
      opts.onPostMetrics?.();
      return { views: 100, likes: 10, comments: 3, shares: 2, collectedAt: new Date().toISOString(), rawData: {} };
    },
    async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
      return { comments: [] };
    },
    async publishReply(): Promise<ReplyResult> {
      return { success: true };
    },
  };
}

function addAccount(id: string, platform = "mock", status: DbAccountStatus = "active", updatedAt?: string): void {
  const now = new Date().toISOString();
  createAccount({ id, name: id, platform, tone_profile: {}, status, created_at: now, updated_at: updatedAt ?? now });
}

function accountMetricRows(): Array<Record<string, unknown>> {
  return getDb()
    .prepare("SELECT * FROM platform_metrics WHERE metric_type = 'account' ORDER BY account_id")
    .all() as Array<Record<string, unknown>>;
}

describe("analytics-scheduler 按账号遍历 (Task 8)", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    clearRegistry();
    cronCallbacks.length = 0;
  });

  afterEach(() => {
    stopScheduler();
    closeDb();
    clearRegistry();
  });

  it("① 账号指标循环:两账号同平台 → 两行 account 指标,各带 account_id", async () => {
    registerAdapterFactory("mock", (accountId) =>
      makeAdapter("mock", { followers: accountId === "acc-1" ? 111 : 222 })
    );
    addAccount("acc-1");
    addAccount("acc-2");

    startScheduler();
    await cronCallbacks[0]!(); // account metrics job

    const rows = accountMetricRows();
    expect(rows.length).toBe(2);
    expect(rows[0]!.account_id).toBe("acc-1");
    expect(rows[0]!.followers).toBe(111);
    expect(rows[1]!.account_id).toBe("acc-2");
    expect(rows[1]!.followers).toBe(222);
  });

  it("② 某账号 adapter 抛错 → 循环继续,其余账号正常落库", async () => {
    registerAdapterFactory("mock", (accountId) =>
      makeAdapter("mock", { failAccount: accountId === "acc-bad", followers: 999 })
    );
    // listAccounts 按 updated_at DESC 排序:给 acc-bad 更晚的时间戳,
    // 确保失败账号排在迭代首位——断言才真实验证"失败跳过不中断后续账号"
    addAccount("acc-good", "mock", "active", "2026-08-20T00:00:00.000Z");
    addAccount("acc-bad", "mock", "active", "2026-08-21T00:00:00.000Z");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startScheduler();
    await cronCallbacks[0]!();

    const rows = accountMetricRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.account_id).toBe("acc-good");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("③ 作品指标:publish_record 有 account_id → 用该账号 adapter 采,指标落 account_id", async () => {
    const postCalls: Record<string, number> = {};
    registerAdapterFactory("mock", (accountId) =>
      makeAdapter("mock", {
        onPostMetrics: () => {
          const key = accountId ?? "default";
          postCalls[key] = (postCalls[key] ?? 0) + 1;
        },
      })
    );
    addAccount("acc-1");
    addAccount("acc-2");
    createPublishRecord({
      work_id: "w1",
      platform: "mock",
      account_id: "acc-2",
      platform_post_id: "post-1",
      status: "published",
      published_at: new Date().toISOString(),
      metadata: "{}",
    });

    startScheduler();
    await cronCallbacks[1]!(); // post metrics job

    expect(postCalls["acc-2"]).toBe(1);
    expect(postCalls["acc-1"] ?? 0).toBe(0);
    const row = getDb()
      .prepare("SELECT * FROM platform_metrics WHERE metric_type = 'work'")
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeTruthy();
    expect(row!.account_id).toBe("acc-2");
  });

  it("④ account_id 为 NULL 的历史记录 → getAdapterForAccount(platform, undefined) 兜底", async () => {
    const factoryCalls: Array<string | undefined> = [];
    registerAdapterFactory("mock", (accountId) => {
      factoryCalls.push(accountId);
      return makeAdapter("mock");
    });
    createPublishRecord({
      work_id: "w1",
      platform: "mock",
      platform_post_id: "post-9",
      status: "published",
      published_at: new Date().toISOString(),
      metadata: "{}",
    });

    startScheduler();
    await cronCallbacks[1]!();

    const row = getDb()
      .prepare("SELECT * FROM platform_metrics WHERE metric_type = 'work'")
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeTruthy();
    expect(row!.account_id).toBeNull();
    expect(factoryCalls).toContain(undefined);
  });

  it("⑤ collectAll({ accountId }) 只采该账号", async () => {
    registerAdapterFactory("mock", (accountId) =>
      makeAdapter("mock", { followers: accountId === "acc-1" ? 111 : 222 })
    );
    addAccount("acc-1");
    addAccount("acc-2");

    const result = await collectAll({ accountId: "acc-1" });

    expect(result.accountMetricsCollected).toBe(1);
    const rows = accountMetricRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.account_id).toBe("acc-1");
    expect(rows[0]!.followers).toBe(111);
  });
});
