import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as recordsRepo from "../../src/db/publish-records-repo.js";
import { createAccount, setDefaultAccount } from "../../src/db/accounts-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import { publishToPlatform, resolvePublishAccountId } from "../../src/services/publishing.js";
import { DouyinPublisher } from "../../src/services/publishers/douyin-publisher.js";
import type { DbAccount } from "../../src/db/types.js";

/** mock publisher 发送行为(不真发);DB 用真内存库 */
function mockDouyinPublishSuccess() {
  return vi.spyOn(DouyinPublisher.prototype, "publish").mockResolvedValue({
    success: true,
    postUrl: "https://mock.test/post/1",
    platformPostId: "p1",
  });
}

function makeAccount(overrides: Partial<DbAccount> = {}): DbAccount {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "测试号",
    platform: "douyin",
    tone_profile: {},
    status: "active",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

const WORK_ID = "w_pub_account";

describe("publish accountId 链路", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    createWork(
      {
        id: WORK_ID,
        title: "测试作品",
        type: "short-video",
        status: "reviewing",
        platforms: ["douyin"],
        evaluation_mode: false,
        tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      []
    );
    mockDouyinPublishSuccess();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
  });

  const input = { workId: WORK_ID, videoPath: "/v.mp4", title: "标题", options: {} };

  it("① 传 accountId → publish_records 行带 account_id,且 accountId 透传进 PublishInput", async () => {
    const account = createAccount(makeAccount());

    const record = await publishToPlatform(WORK_ID, "douyin", { ...input, accountId: account.id });

    const row = recordsRepo.getPublishRecord(record.id);
    expect(row?.account_id).toBe(account.id);
    // accountId 透传给 publisher(Task 5 用于多 context)
    expect(vi.mocked(DouyinPublisher.prototype.publish)).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: account.id })
    );
  });

  it("② 同作品同平台不同 accountId 连发两次 → 两行记录", async () => {
    const a1 = createAccount(makeAccount({ name: "号1" }));
    const a2 = createAccount(makeAccount({ name: "号2" }));

    await publishToPlatform(WORK_ID, "douyin", { ...input, accountId: a1.id });
    await publishToPlatform(WORK_ID, "douyin", { ...input, accountId: a2.id });

    const rows = recordsRepo.listPublishRecords({ workId: WORK_ID });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.account_id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it("③ 同作品同平台同 accountId 连发两次 → 第二次被拒(批次7.6 禁重发)", async () => {
    // 语义变更(2026-08-28):首次发布成功后记录为 published,重复发布=重复发帖事故源,
    // 必须显式拒绝;只有 failed 记录才走复用重发
    const account = createAccount(makeAccount());

    const first = await publishToPlatform(WORK_ID, "douyin", { ...input, accountId: account.id });
    await expect(publishToPlatform(WORK_ID, "douyin", { ...input, accountId: account.id }))
      .rejects.toThrow("禁止重复发布");

    expect(recordsRepo.listPublishRecords({ workId: WORK_ID })).toHaveLength(1);
    expect(first.status).toBe("published");
  });

  it("③b account_id 缺省(null/undefined)与显式 undefined 视为同值 → 已发布同样拒重发", async () => {
    const first = await publishToPlatform(WORK_ID, "douyin", input);
    await expect(publishToPlatform(WORK_ID, "douyin", input)).rejects.toThrow("禁止重复发布");

    expect(recordsRepo.listPublishRecords({ workId: WORK_ID })).toHaveLength(1);
    expect(first.status).toBe("published");
  });

  it("④ accountId 属于别的平台 → throw 不属于平台", async () => {
    const xhsAccount = createAccount(makeAccount({ platform: "xiaohongshu" }));

    await expect(
      publishToPlatform(WORK_ID, "douyin", { ...input, accountId: xhsAccount.id })
    ).rejects.toThrow("不属于平台");
    // 未落任何记录
    expect(recordsRepo.listPublishRecords({ workId: WORK_ID })).toHaveLength(0);
  });

  it("④b accountId 不存在 → throw 账号不存在", async () => {
    await expect(
      publishToPlatform(WORK_ID, "douyin", { ...input, accountId: randomUUID() })
    ).rejects.toThrow("账号不存在");
  });

  it("⑤ 不传 accountId → 落该平台默认账号 id", async () => {
    const account = createAccount(makeAccount());
    setDefaultAccount("douyin", account.id);

    const record = await publishToPlatform(WORK_ID, "douyin", input);

    const row = recordsRepo.getPublishRecord(record.id);
    expect(row?.account_id).toBe(account.id);
  });

  it("⑤b 不传 accountId 且平台无默认账号 → account_id 为空(旧凭证兜底)", async () => {
    const record = await publishToPlatform(WORK_ID, "douyin", input);

    const row = recordsRepo.getPublishRecord(record.id);
    expect(row?.account_id).toBeUndefined();
  });

  // 2026-08-21 终审 I2:无默认账号时镜像 resolveAccountCredential 语义,
  // 回落第一个活跃账号并告警,而不是直接 undefined(落账错位到旧凭证兜底)
  it("⑤c 无默认账号但有活跃账号 → 回落活跃账号并 console.warn", async () => {
    const active = createAccount(makeAccount({ name: "活跃号" })); // is_default 默认 0
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = await publishToPlatform(WORK_ID, "douyin", input);

    const row = recordsRepo.getPublishRecord(record.id);
    expect(row?.account_id).toBe(active.id);
    const warnText = warn.mock.calls.flat().join(" ");
    expect(warnText).toContain("默认账号");
    expect(warnText).toContain(active.id);
  });

  it("⑤d 回落只取活跃账号:停用账号不回退", () => {
    createAccount(makeAccount({ name: "停用号", status: "inactive" }));

    expect(resolvePublishAccountId("douyin")).toBeUndefined();
  });

  it("resolvePublishAccountId 显式 > 默认 > undefined", () => {
    const explicit = createAccount(makeAccount({ name: "显式" }));
    const def = createAccount(makeAccount({ name: "默认" }));
    setDefaultAccount("douyin", def.id);

    expect(resolvePublishAccountId("douyin", explicit.id)).toBe(explicit.id);
    expect(resolvePublishAccountId("douyin")).toBe(def.id);
    expect(resolvePublishAccountId("zhihu")).toBeUndefined();
    expect(() => resolvePublishAccountId("douyin", randomUUID())).toThrow("账号不存在");
    expect(() => resolvePublishAccountId("zhihu", explicit.id)).toThrow("不属于平台");
  });
});
