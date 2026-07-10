import { describe, it, expect, beforeEach } from "vitest";
import { resetInMemoryDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAccount } from "../../src/db/publish-accounts-repo.js";
import { updateJob } from "../../src/db/publish-jobs-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import { publishRoutes } from "../../src/server/publish-api.js";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

function createTestApp() {
  const app = new Hono();
  app.route("/api/publish", publishRoutes);
  return app;
}

describe("publish API", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  it("lists accounts", async () => {
    createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const app = createTestApp();
    const res = await app.request("/api/publish/accounts");
    const json = await res.json();
    expect(json.accounts).toHaveLength(1);
  });

  it("rejects publish with 400 when workId is missing", async () => {
    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountIds: ["acc-1"], title: "标题", content: "正文" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("workId");
  });

  it("rejects publish with 400 when title is missing", async () => {
    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: "w-1", accountIds: ["acc-1"], content: "正文" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("title");
  });

  it("rejects publish with 400 when accountIds is not an array", async () => {
    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: "w-1", accountIds: "acc-1", title: "标题", content: "正文" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("accountIds");
  });

  it("blocks publish on compliance violation and allows force publish", async () => {
    const account = createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
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

    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: work.id, accountIds: [account.id], title: "赌博技巧", content: "正文", forcePublish: false }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.compliance.violations.length).toBeGreaterThan(0);

    const res2 = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: work.id, accountIds: [account.id], title: "赌博技巧", content: "正文", forcePublish: true }),
    });
    expect(res2.status).toBe(201);
    const json2 = await res2.json();
    expect(json2.jobs).toHaveLength(1);
  });

  it("gets a job and retries a failed job", async () => {
    const account = createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
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

    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: work.id, accountIds: [account.id], title: "标题", content: "正文" }),
    });
    const { jobs } = await res.json() as { jobs: { id: string }[] };
    const jobId = jobs[0].id;

    const getRes = await app.request(`/api/publish/jobs/${jobId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.job.id).toBe(jobId);

    // Set the job to "failed" status so we can test retry
    updateJob(jobId, { status: "failed", error: "Simulated failure" });

    const retryRes = await app.request(`/api/publish/jobs/${jobId}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(200);
  });

  it("returns 400 when retrying a non-failed job", async () => {
    const account = createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
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

    const app = createTestApp();
    const res = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: work.id, accountIds: [account.id], title: "标题", content: "正文" }),
    });
    const { jobs } = await res.json() as { jobs: { id: string }[] };
    const jobId = jobs[0].id;

    // Set the job to "published" (not "failed") so retry should be rejected
    updateJob(jobId, { status: "published" });

    const retryRes = await app.request(`/api/publish/jobs/${jobId}/retry`, { method: "POST" });
    expect(retryRes.status).toBe(400);
    const json = await retryRes.json();
    expect(json.error).toContain("Only failed jobs can be retried");
  });

  it("returns 404 when retrying a non-existent job", async () => {
    const app = createTestApp();
    const res = await app.request(`/api/publish/jobs/${randomUUID()}/retry`, { method: "POST" });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Job not found");
  });

  it("returns 400 when deleting an account with existing publish jobs", async () => {
    const account = createAccount({
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "主号",
      credentials: {},
      status: "active",
      is_default: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
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

    const app = createTestApp();
    // Create a publish job for the account
    const postRes = await app.request("/api/publish/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: work.id, accountIds: [account.id], title: "标题", content: "正文" }),
    });
    expect(postRes.status).toBe(201);

    // Attempt to delete the account — should fail due to FK constraint
    const delRes = await app.request(`/api/publish/accounts/${account.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(400);
    const json = await delRes.json();
    expect(json.error).toContain("Cannot delete account with existing publish jobs");
  });

  it("manages banned words", async () => {
    const app = createTestApp();
    const res = await app.request("/api/publish/banned-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "xiaohongshu", word: "引流", severity: "medium" }),
    });
    expect(res.status).toBe(201);

    const listRes = await app.request("/api/publish/banned-words?platform=xiaohongshu");
    const json = await listRes.json();
    expect(json.words.some((w: { word: string }) => w.word === "引流")).toBe(true);
  });

  it("rejects banned-words with 400 for invalid severity", async () => {
    const app = createTestApp();
    const res = await app.request("/api/publish/banned-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "xiaohongshu", word: "引流", severity: "invalid" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("severity");
  });
});
