import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetInMemoryDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as accountsRepo from "../../src/db/publish-accounts-repo.js";
import * as jobsRepo from "../../src/db/publish-jobs-repo.js";
import { createWork, getWork } from "../../src/db/works-repo.js";
import { createPublishJobs, resetPublishQueues, retryPublishJob, recoverStuckJobs } from "../../src/services/publish-service.js";
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
});
