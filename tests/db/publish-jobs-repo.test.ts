import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { randomUUID } from "node:crypto";
import * as accountsRepo from "../../src/db/publish-accounts-repo.js";
import * as jobsRepo from "../../src/db/publish-jobs-repo.js";
import type { DbPublishJob } from "../../src/db/types.js";

/** Create an account and return its ID. */
function createAccount(): string {
  const id = randomUUID();
  accountsRepo.createAccount({
    id, platform: "douyin", display_name: "Test Account",
    credentials: {}, status: "active", is_default: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  return id;
}

/** Build a DbPublishJob with sensible defaults. */
function makeJob(accountId: string, overrides: Partial<DbPublishJob> = {}): DbPublishJob {
  return {
    id: randomUUID(),
    work_id: null,
    render_job_id: null,
    account_id: accountId,
    platform: "douyin",
    title: "Test Title",
    content: "Test content for publishing",
    media_path: null,
    status: "pending",
    compliance_result: { passed: true, violations: [] },
    error: null,
    post_url: null,
    published_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("publish-jobs-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a job", () => {
    const aid = createAccount();
    const job = makeJob(aid);
    jobsRepo.createJob(job);
    const found = jobsRepo.getJob(job.id);
    expect(found?.title).toBe("Test Title");
    expect(found?.compliance_result).toEqual({ passed: true, violations: [] });
  });

  it("returns undefined for missing job", () => {
    expect(jobsRepo.getJob("nonexistent")).toBeUndefined();
  });

  it("lists jobs with default limit", () => {
    const aid = createAccount();
    const job1 = makeJob(aid, { id: randomUUID(), title: "Job 1", updated_at: "2026-01-02T00:00:00Z" });
    const job2 = makeJob(aid, { id: randomUUID(), title: "Job 2", updated_at: "2026-01-01T00:00:00Z" });
    jobsRepo.createJob(job1);
    jobsRepo.createJob(job2);
    const jobs = jobsRepo.listJobs();
    expect(jobs.length).toBe(2);
    expect(jobs[0].title).toBe("Job 1");
  });

  it("filters jobs by status", () => {
    const aid = createAccount();
    const pending = makeJob(aid, { id: randomUUID(), status: "pending" });
    const published = makeJob(aid, { id: randomUUID(), status: "published" });
    jobsRepo.createJob(pending);
    jobsRepo.createJob(published);
    const found = jobsRepo.listJobs({ status: "published" });
    expect(found.length).toBe(1);
    expect(found[0].id).toBe(published.id);
  });

  it("filters jobs by work_id", () => {
    const aid = createAccount();
    // work_id needs to reference an existing work due to FK constraint
    const workId = randomUUID();
    getDb().prepare(
      "INSERT INTO works (id, title, type, status, platforms, evaluation_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(workId, "Test Work", "short-video", "draft", "[]", 0, "", "");

    const job1 = makeJob(aid, { id: randomUUID(), work_id: workId });
    const job2 = makeJob(aid, { id: randomUUID(), work_id: null });
    jobsRepo.createJob(job1);
    jobsRepo.createJob(job2);
    const found = jobsRepo.listJobs({ workId });
    expect(found.length).toBe(1);
    expect(found[0].id).toBe(job1.id);
  });

  it("supports pagination", () => {
    const aid = createAccount();
    for (let i = 0; i < 5; i++) {
      jobsRepo.createJob(makeJob(aid, { id: randomUUID(), title: `Job ${i}` }));
    }
    const page1 = jobsRepo.listJobs({ limit: 2, offset: 0 });
    expect(page1.length).toBe(2);
    const page2 = jobsRepo.listJobs({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it("updates a job", () => {
    const aid = createAccount();
    const job = makeJob(aid);
    jobsRepo.createJob(job);
    const updated = jobsRepo.updateJob(job.id, { status: "published", post_url: "https://example.com/post" });
    expect(updated?.status).toBe("published");
    expect(updated?.post_url).toBe("https://example.com/post");
    const found = jobsRepo.getJob(job.id);
    expect(found?.status).toBe("published");
  });

  it("returns undefined when updating nonexistent job", () => {
    expect(jobsRepo.updateJob("nonexistent", { status: "published" })).toBeUndefined();
  });

  it("preserves compliance_result with violations", () => {
    const aid = createAccount();
    const job = makeJob(aid, {
      id: randomUUID(),
      compliance_result: { passed: false, violations: [{ platform: "douyin", word: "赌", severity: "high", context: "test" }] },
    });
    jobsRepo.createJob(job);
    const found = jobsRepo.getJob(job.id);
    expect(found?.compliance_result.passed).toBe(false);
    expect(found?.compliance_result.violations.length).toBe(1);
  });

  it("deletes a job", () => {
    const aid = createAccount();
    const job = makeJob(aid);
    jobsRepo.createJob(job);
    expect(jobsRepo.deleteJob(job.id)).toBe(true);
    expect(jobsRepo.getJob(job.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent job", () => {
    expect(jobsRepo.deleteJob("nonexistent")).toBe(false);
  });
});
