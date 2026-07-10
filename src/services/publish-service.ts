import type { ComplianceResult } from "./compliance-text.js";
import { scanBannedWords } from "./compliance-text.js";
import { getDriver } from "./publish-factory.js";
import { getAccount } from "../db/publish-accounts-repo.js";
import { createJob, getJob, updateJob } from "../db/publish-jobs-repo.js";
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
      render_job_id: request.renderJobId ?? null,
      account_id: account.id,
      platform: account.platform,
      title: request.title,
      content: request.content,
      media_path: request.mediaPath ?? null,
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

async function runPublishJob(jobId: string): Promise<void> {
  let job: ReturnType<typeof getJob>;

  try {
    job = getJob(jobId);
    if (!job) return;

    const driver = getDriver(job.platform);
    const result = await driver.publish({
      title: job.title,
      content: job.content,
      mediaPath: job.media_path ?? undefined,
    });
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
