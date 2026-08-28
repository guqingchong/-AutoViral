import type { ComplianceResult } from "./compliance-text.js";
import { scanBannedWords } from "./compliance-text.js";
import { getDriver } from "./publish-factory.js";
import { getAccount } from "../db/publish-accounts-repo.js";
import { createJob, getJob, updateJob, listJobs, listStuckJobs } from "../db/publish-jobs-repo.js";
import { getWork, updateWork } from "../db/works-repo.js";
import { randomUUID } from "node:crypto";

export interface CreatePublishJobsRequest {
  workId: string;
  renderJobId?: string;
  accountIds: string[];
  title: string;
  content: string;
  mediaPath?: string;
  forcePublish?: boolean;
}

export interface CreatePublishJobsResult {
  blocked: boolean;
  compliance: ComplianceResult;
  error?: string;
  jobs: Array<{ id: string; platform: string; status: string }>;
}

const accountQueues = new Map<string, Promise<unknown>>();

export function resetPublishQueues(): void {
  accountQueues.clear();
}

function enqueueAccount(accountId: string, jobId: string): void {
  const previous = accountQueues.get(accountId) ?? Promise.resolve();
  const next = previous
    .then(() => runPublishJob(jobId))
    .catch(() => {
      // runPublishJob catches internally; this is a defensive safety net
    })
    .finally(() => {
      if (accountQueues.get(accountId) === next) {
        accountQueues.delete(accountId);
      }
    });
  accountQueues.set(accountId, next);
}

export function createPublishJobs(request: CreatePublishJobsRequest): CreatePublishJobsResult {
  if (request.accountIds.length === 0) {
    return {
      blocked: true,
      compliance: { passed: false, violations: [] },
      error: "At least one account must be selected",
      jobs: [],
    };
  }

  const lookupResults = request.accountIds.map((id) => ({ id, account: getAccount(id) }));

  const missingIds = lookupResults.filter((r) => !r.account).map((r) => r.id);
  if (missingIds.length > 0) {
    return {
      blocked: true,
      compliance: { passed: false, violations: [] },
      error: "One or more accounts were not found",
      jobs: [],
    };
  }

  const inactiveIds = lookupResults.filter((r) => r.account!.status !== "active").map((r) => r.id);
  if (inactiveIds.length > 0) {
    return {
      blocked: true,
      compliance: { passed: false, violations: [] },
      error: "One or more accounts are not active",
      jobs: [],
    };
  }

  const accounts = lookupResults.map((r) => r.account!);

  const combinedText = request.title + request.content;
  const platformChecks = new Map<string, ComplianceResult>();
  for (const account of accounts) {
    if (!platformChecks.has(account.platform)) {
      platformChecks.set(account.platform, scanBannedWords({ text: combinedText, platform: account.platform }));
    }
  }

  const allViolations = Array.from(platformChecks.values()).flatMap((r) => r.violations);
  const combinedCompliance: ComplianceResult = {
    passed: allViolations.length === 0,
    violations: allViolations,
  };

  if (!combinedCompliance.passed && !request.forcePublish) {
    return { blocked: true, compliance: combinedCompliance, jobs: [] };
  }

  const jobs: Array<{ id: string; platform: string; status: string }> = [];

  for (const account of accounts) {
    const compliance = platformChecks.get(account.platform)!;

    const job = createJob({
      id: randomUUID(),
      work_id: request.workId,
      render_job_id: request.renderJobId || null,
      account_id: account.id,
      platform: account.platform,
      title: request.title,
      content: request.content,
      media_path: request.mediaPath || null,
      status: "publishing",
      compliance_result: compliance,
      error: null,
      post_url: null,
      published_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    jobs.push({ id: job.id, platform: job.platform, status: job.status });

    enqueueAccount(account.id, job.id);
  }

  return { blocked: false, compliance: combinedCompliance, jobs };
}

/**
 * Default publish timeout in milliseconds.
 * Override via PUBLISH_TIMEOUT_MS environment variable.
 */
function getPublishTimeoutMs(): number {
  const env = process.env.PUBLISH_TIMEOUT_MS;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5 * 60 * 1000; // default 5 minutes
}

/** Create a promise that rejects after the given timeout. */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Publish timeout")), ms);
  });
}

async function runPublishJob(jobId: string): Promise<void> {
  let job: ReturnType<typeof getJob>;

  try {
    job = getJob(jobId);
    if (!job) return;

    const driver = getDriver(job.platform);
    const timeoutMs = getPublishTimeoutMs();
    // 批次7.6:超时必须尝试取消底层流程——此前 Promise.race 只拒 promise,
    // 底层 Playwright/fetch 还在跑,retry 造成重复发帖(事故级)
    const abort = new AbortController();
    const result = await Promise.race([
      driver.publish({
        title: job.title,
        content: job.content,
        mediaPath: job.media_path ?? undefined,
        signal: abort.signal,
      }),
      timeoutPromise(timeoutMs).catch((err) => { abort.abort(); throw err; }),
    ]);
    updateJob(jobId, {
      status: "published",
      post_url: result.postUrl,
      published_at: result.publishedAt,
    });
  } catch (err) {
    try {
      updateJob(jobId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Can't even update status; at least don't reject the promise
    }
    return;
  }

  // Best-effort work status update — publish already succeeded,
  // so a work update failure must not overwrite the job status.
  if (job.work_id) {
    try {
      const work = getWork(job.work_id);
      if (work && work.status !== "published") {
        updateWork(work.id, { status: "published" });
      }
    } catch {
      // non-critical: publish succeeded, work update is secondary
    }
  }
}

export function recoverStuckJobs(): void {
  const stuckJobs = listStuckJobs();
  for (const job of stuckJobs) {
    try {
      updateJob(job.id, {
        status: "failed",
        error: "Server restarted before publish completed",
      });
    } catch {
      // Best-effort; don't let one failure block recovery of others
    }
  }
}

export function retryPublishJob(jobId: string): void {
  const job = getJob(jobId);
  if (!job) throw new Error("Job not found");
  if (job.status !== "failed") throw new Error("Only failed jobs can be retried");

  const account = getAccount(job.account_id);
  if (!account) throw new Error("Account not found");
  if (account.status !== "active") throw new Error("Account is not active");

  updateJob(jobId, { status: "publishing", error: null });
  enqueueAccount(job.account_id, jobId);
}

// ── Periodic stuck-job sweep ───────────────────────────────────────────────

let cronJob: ReturnType<typeof setInterval> | null = null;

/**
 * Hard threshold: jobs whose updated_at is older than this duration (ms)
 * and still in "publishing" status are considered stuck.
 */
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Recover jobs that have been stuck in "publishing" status beyond the
 * threshold (10 minutes by default). This is the periodic sweep variant
 * that avoids touching recently-started jobs.
 */
export function recoverTimedOutStuckJobs(): void {
  const stuckJobs = listStuckJobs();
  const cutoff = Date.now() - STUCK_THRESHOLD_MS;
  for (const job of stuckJobs) {
    const updatedAt = new Date(job.updated_at).getTime();
    if (updatedAt < cutoff) {
      try {
        updateJob(job.id, {
          status: "failed",
          error: "Publish timed out — stuck in publishing for more than 10 minutes",
        });
      } catch {
        // Best-effort
      }
    }
  }
}

/**
 * Start the periodic stuck-job sweep using setInterval.
 * Runs every `intervalMs` (default 5 minutes).
 * Returns the timer handle for testing/cleanup.
 */
export function startPublishCron(intervalMs: number = 5 * 60 * 1000): ReturnType<typeof setInterval> {
  if (cronJob) clearInterval(cronJob);
  cronJob = setInterval(() => {
    try {
      recoverTimedOutStuckJobs();
    } catch {
      // Never let the cron crash
    }
  }, intervalMs);
  return cronJob;
}

/**
 * Stop the periodic stuck-job sweep.
 */
export function stopPublishCron(): void {
  if (cronJob) {
    clearInterval(cronJob);
    cronJob = null;
  }
}
