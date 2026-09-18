import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as recordsRepo from "../../src/db/publish-records-repo.js";
import { createWork as dbCreateWork } from "../../src/db/works-repo.js";

// 2026-09-18 实测根因:发布是 5-10 分钟长任务,前端离开页面后内存态丢失,
// 用户重复点击会在同一 (work, platform, account) 上并发跑出第二个 Playwright 流程;
// 发布器实例按账号缓存,先结束者的 finally close() 会杀掉另一个的浏览器(发布真中断)。
// publishToPlatform 必须对未卡死的 publishing 记录幂等拒绝。

const publishMock = vi.fn(async () => ({ success: true as const, postUrl: "https://example.com/video/1" }));

vi.mock("../../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/config.js")>();
  const dir = await mkdtemp(join(tmpdir(), "autoviral-publish-guard-test-"));
  return { ...orig, dataDir: dir, __testDataDir: dir };
});

vi.mock("../../src/services/publishers/douyin-publisher.js", () => ({
  DouyinPublisher: class {
    readonly platform = "douyin";
    readonly name = "抖音";
    async isConfigured() { return true; }
    async publish(...args: unknown[]) { return publishMock(...args); }
  },
}));

import { publishToPlatform } from "../../src/services/publishing.js";

function seedWork(id = "w_guard") {
  dbCreateWork(
    {
      id,
      title: "测试作品",
      type: "short-video",
      status: "approved",
      platforms: ["douyin"],
      evaluation_mode: false,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    []
  );
}

const INPUT = { workId: "w_guard", videoPath: "x.mp4", title: "t", options: {} };

describe("publishToPlatform 并发防护(publishing 记录)", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    publishMock.mockClear();
  });
  afterEach(() => closeDb());

  it("未卡死的 publishing 记录:拒绝重复提交,不触发第二次发布", async () => {
    seedWork();
    // 模拟进行中的发布:2 分钟前更新过的 publishing 记录
    const rec = recordsRepo.createPublishRecord({
      work_id: "w_guard",
      platform: "douyin",
      status: "publishing",
      metadata: "",
    });
    getDb()
      .prepare("UPDATE publish_records SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60_000).toISOString(), rec.id);

    await expect(publishToPlatform("w_guard", "douyin", INPUT)).rejects.toThrow(/正在发布中/);
    expect(publishMock).not.toHaveBeenCalled();
    // 记录保持 publishing,不被重置
    expect(recordsRepo.getPublishRecord(rec.id)!.status).toBe("publishing");
  });

  it("卡死的 publishing 记录(超过 10 分钟未更新):允许复用重来", async () => {
    seedWork();
    const rec = recordsRepo.createPublishRecord({
      work_id: "w_guard",
      platform: "douyin",
      status: "publishing",
      metadata: "",
    });
    getDb()
      .prepare("UPDATE publish_records SET updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 15 * 60_000).toISOString(), rec.id);

    const result = await publishToPlatform("w_guard", "douyin", INPUT);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("published");
    expect(result.id).toBe(rec.id); // 复用原记录而非新建
  });

  it("fallback 状态的旧记录:允许重发(现状不回归)", async () => {
    seedWork();
    recordsRepo.createPublishRecord({
      work_id: "w_guard",
      platform: "douyin",
      status: "fallback",
      metadata: "",
    });

    const result = await publishToPlatform("w_guard", "douyin", INPUT);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("published");
  });
});
