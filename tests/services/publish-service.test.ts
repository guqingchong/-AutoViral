import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetInMemoryDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as accountsRepo from "../../src/db/publish-accounts-repo.js";
import * as jobsRepo from "../../src/db/publish-jobs-repo.js";
import { createWork, getWork } from "../../src/db/works-repo.js";
import { createPublishJobs, resetPublishQueues, retryPublishJob, recoverStuckJobs, recoverTimedOutStuckJobs, stopPublishCron } from "../../src/services/publish-service.js";
import * as publishFactory from "../../src/services/publish-factory.js";
import { randomUUID } from "node:crypto";

describe("publish-service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    resetPublishQueues();
    vi.restoreAllMocks();
    // Stub getDriver to return a deterministic mock so async publish tests
    // are fast (no 1-3s delay) and not flaky (no 5% random failure).
    vi.spyOn(publishFactory, "getDriver").mockReturnValue({
      platform: "xiaohongshu",
      async publish() {
        return { postUrl: "https://mock.test/post/abc", publishedAt: new Date().toISOString() };
      },
    });
  });

  it("blocks publish when no accounts selected", () => {
    const result = createPublishJobs({
      workId: randomUUID(),
      accountIds: [],
      title: "标题",
      content: "内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.error).toBe("At least one account must be selected");
    expect(result.jobs).toHaveLength(0);
  });

  it("blocks publish when banned words found", () => {
    const work = createWork({
      id: randomUUID(),
      title: "赌博技巧",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "赌博技巧",
      content: "内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.jobs).toHaveLength(0);
  });

  it("allows force publish after compliance failure", () => {
    const work = createWork({
      id: randomUUID(),
      title: "标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "赌博技巧",
      content: "内容",
      forcePublish: true,
    });

    expect(result.blocked).toBe(false);
    expect(result.jobs).toHaveLength(1);
  });

  it("blocks publish when account is not found", () => {
    const work = createWork({
      id: randomUUID(),
      title: "标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);

    const result = createPublishJobs({
      workId: work.id,
      accountIds: ["nonexistent-id"],
      title: "正常标题",
      content: "内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.error).toContain("not found");
    expect(result.jobs).toHaveLength(0);
  });

  it("blocks publish when account is inactive", () => {
    const work = createWork({
      id: randomUUID(),
      title: "标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "disabled",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "正常标题",
      content: "内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.error).toContain("not active");
    expect(result.jobs).toHaveLength(0);
  });

  it("publishes job asynchronously and updates work status", async () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "测试标题",
      content: "正文内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(false);
    expect(result.jobs).toHaveLength(1);
    const jobId = result.jobs[0].id;

    // Wait for the queued promise to settle (mock driver is synchronous)
    await new Promise((resolve) => setTimeout(resolve, 0));

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("published");
    expect(job?.post_url).toBe("https://mock.test/post/abc");

    const updatedWork = getWork(work.id);
    expect(updatedWork?.status).toBe("published");
  });

  it("sets job to failed when driver.publish throws", async () => {
    // Override the default mock to simulate a publish failure
    vi.spyOn(publishFactory, "getDriver").mockReturnValue({
      platform: "xiaohongshu",
      async publish() {
        throw new Error("Simulated publish failure");
      },
    });

    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "测试标题",
      content: "正文内容",
      forcePublish: false,
    });

    expect(result.blocked).toBe(false);
    expect(result.jobs).toHaveLength(1);
    const jobId = result.jobs[0].id;

    // Wait for the queued promise to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Simulated publish failure");
  });

  it("retries a failed publish job", async () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Seed a failed job directly via the repo
    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "测试标题",
      content: "正文内容",
      media_path: null,
      status: "failed",
      compliance_result: { passed: true, violations: [] },
      error: "Previous failure",
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    retryPublishJob(jobId);

    // Wait for the queued promise to settle
    await new Promise((resolve) => setTimeout(resolve, 0));

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("published");
    expect(job?.post_url).toBe("https://mock.test/post/abc");
  });

  it("throws on retry when job is not found", () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "测试标题",
      content: "正文内容",
      media_path: null,
      status: "failed",
      compliance_result: { passed: true, violations: [] },
      error: "Previous failure",
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Delete the job and account after creating the job
    jobsRepo.deleteJob(jobId);
    accountsRepo.deleteAccount(account.id);

    expect(() => retryPublishJob(jobId)).toThrow(/not found/i);
  });

  it("throws on retry when account is not found", () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "测试标题",
      content: "正文内容",
      media_path: null,
      status: "failed",
      compliance_result: { passed: true, violations: [] },
      error: "Previous failure",
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Disable FK enforcement to delete the account that has a job
    getDb().pragma("foreign_keys = OFF");
    accountsRepo.deleteAccount(account.id);
    getDb().pragma("foreign_keys = ON");

    expect(() => retryPublishJob(jobId)).toThrow(/Account not found/i);
  });

  it("throws on retry when account is not active", () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "测试标题",
      content: "正文内容",
      media_path: null,
      status: "failed",
      compliance_result: { passed: true, violations: [] },
      error: "Previous failure",
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Disable the account after creating the job
    accountsRepo.updateAccount(account.id, { status: "disabled" });

    expect(() => retryPublishJob(jobId)).toThrow(/not active/i);
  });

  it("serializes concurrent publishes to the same account", async () => {
    const work = createWork({
      id: randomUUID(),
      title: "标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const executionOrder: string[] = [];
    let callCount = 0;
    vi.spyOn(publishFactory, "getDriver").mockReturnValue({
      platform: "xiaohongshu",
      async publish() {
        const seq = ++callCount;
        executionOrder.push(`start-${seq}`);
        return new Promise((resolve) => {
          setTimeout(() => {
            executionOrder.push(`end-${seq}`);
            resolve({ postUrl: `https://mock.test/post/${seq}`, publishedAt: new Date().toISOString() });
          }, 10);
        });
      },
    });

    const result1 = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "标题1",
      content: "内容1",
    });
    const result2 = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "标题2",
      content: "内容2",
    });

    expect(result1.jobs).toHaveLength(1);
    expect(result2.jobs).toHaveLength(1);

    // Wait for both to settle
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The first job must complete before the second starts (serialized per account)
    expect(executionOrder).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("checks compliance once per unique platform across multiple accounts", async () => {
    const work = createWork({
      id: randomUUID(),
      title: "正常标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account1 = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "号1",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const account2 = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "号2",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const scanSpy = vi.spyOn(await import("../../src/services/compliance-text.js"), "scanBannedWords");

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account1.id, account2.id],
      title: "正常标题",
      content: "正常内容",
    });

    expect(result.blocked).toBe(false);
    expect(result.jobs).toHaveLength(2);
    // scanBannedWords should only be called once for "xiaohongshu"
    const xhsCalls = scanSpy.mock.calls.filter(c => c[0].platform === "xiaohongshu");
    expect(xhsCalls).toHaveLength(1);
  });

  it("handles null work_id gracefully during publish", async () => {
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Create a job directly with null work_id
    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: null,
      render_job_id: null,
      account_id: account.id,
      platform: "xiaohongshu",
      title: "标题",
      content: "内容",
      media_path: null,
      status: "publishing",
      compliance_result: { passed: true, violations: [] },
      error: null,
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Manually trigger runPublishJob via retryPublishJob
    jobsRepo.updateJob(jobId, { status: "failed", error: "test" });
    retryPublishJob(jobId);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("published");
  });

  it("throws on retry when job status is publishing (not failed)", () => {
    const work = createWork({
      id: randomUUID(),
      title: "标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "标题",
      content: "内容",
      media_path: null,
      status: "publishing",
      compliance_result: { passed: true, violations: [] },
      error: null,
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(() => retryPublishJob(jobId)).toThrow("Only failed jobs can be retried");
  });

  it("marks job as failed on publish timeout", async () => {
    // Set an extremely low timeout so the mock driver will time out
    const origTimeout = process.env.PUBLISH_TIMEOUT_MS;
    process.env.PUBLISH_TIMEOUT_MS = "50";

    vi.spyOn(publishFactory, "getDriver").mockReturnValue({
      platform: "xiaohongshu",
      async publish() {
        // This promise takes longer than the 50ms timeout
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { postUrl: "https://mock.test/post/abc", publishedAt: new Date().toISOString() };
      },
    });

    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const result = createPublishJobs({
      workId: work.id,
      accountIds: [account.id],
      title: "测试标题",
      content: "正文内容",
    });

    expect(result.blocked).toBe(false);
    const jobId = result.jobs[0].id;

    // Wait for the timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 200));

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("Publish timeout");

    // Restore env
    if (origTimeout !== undefined) {
      process.env.PUBLISH_TIMEOUT_MS = origTimeout;
    } else {
      delete process.env.PUBLISH_TIMEOUT_MS;
    }
  });

  it("recovers stuck publishing jobs on startup", () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const jobId = randomUUID();
    jobsRepo.createJob({
      id: jobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: account.platform,
      title: "测试标题",
      content: "正文内容",
      media_path: null,
      status: "publishing",
      compliance_result: { passed: true, violations: [] },
      error: null,
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    recoverStuckJobs();

    const job = jobsRepo.getJob(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Server restarted before publish completed");
  });

  it("recoverTimedOutStuckJobs only recovers jobs updated beyond threshold", () => {
    const work = createWork({
      id: randomUUID(),
      title: "测试标题",
      type: "short-video",
      status: "draft",
      platforms: [],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, []);
    const account = accountsRepo.createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Job stuck for a long time (should be recovered)
    const oldJobId = randomUUID();
    const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    jobsRepo.createJob({
      id: oldJobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: "xiaohongshu",
      title: "旧任务",
      content: "内容",
      media_path: null,
      status: "publishing",
      compliance_result: { passed: true, violations: [] },
      error: null,
      post_url: null,
      published_at: null,
      created_at: oldDate,
      updated_at: oldDate,
    });

    // Job stuck recently (should NOT be recovered)
    const recentJobId = randomUUID();
    const recentDate = new Date().toISOString();
    jobsRepo.createJob({
      id: recentJobId,
      work_id: work.id,
      render_job_id: null,
      account_id: account.id,
      platform: "xiaohongshu",
      title: "新任务",
      content: "内容",
      media_path: null,
      status: "publishing",
      compliance_result: { passed: true, violations: [] },
      error: null,
      post_url: null,
      published_at: null,
      created_at: recentDate,
      updated_at: recentDate,
    });

    recoverTimedOutStuckJobs();

    expect(jobsRepo.getJob(oldJobId)?.status).toBe("failed");
    expect(jobsRepo.getJob(recentJobId)?.status).toBe("publishing");
  });
});
