import { describe, it, expect, beforeEach } from "vitest";
import { resetInMemoryDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as accountsRepo from "../../src/db/publish-accounts-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import { createPublishJobs, retryPublishJob } from "../../src/services/publish-service.js";
import { randomUUID } from "node:crypto";

describe("publish-service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
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
});
