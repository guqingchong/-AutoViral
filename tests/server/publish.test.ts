import { describe, it, expect, beforeEach } from "vitest";
import { resetInMemoryDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAccount } from "../../src/db/publish-accounts-repo.js";
import { createJob, updateJob } from "../../src/db/publish-jobs-repo.js";
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
});
