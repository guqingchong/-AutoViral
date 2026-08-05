import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork } from "../../src/db/works-repo.js";
import * as queueRepo from "../../src/db/work-queue-repo.js";
import type { DbWork, DbPipelineStep } from "../../src/db/types.js";

// 隔离 work-store 的 legacy 迁移（避免读取真实 dataDir 污染内存库）
vi.mock("../../src/db/migrate-legacy.js", () => ({
  migrateLegacyWorks: vi.fn(async () => 0),
}));

import {
  findStalledWorks,
  lastActivityOf,
  _scanOnceForTest,
  _resetWatchdog,
  STALL_MS,
} from "../../src/services/work-watchdog.js";
import { _resetRunner } from "../../src/services/work-queue.js";
import { listWorks } from "../../src/work-store.js";

// 固定"现在"，所有用例围绕它构造相对时间
const NOW = new Date("2026-08-05T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
/** datetime('now') 空格格式（UTC，无时区后缀） */
const spaceFormat = (iso: string) => iso.slice(0, 19).replace("T", " ");

function makeWork(id: string, status: DbWork["status"], updatedAt: string): DbWork {
  return {
    id,
    title: `Work ${id}`,
    type: "short-video",
    status,
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function makeStep(
  workId: string,
  key: string,
  overrides: Partial<DbPipelineStep> = {},
): DbPipelineStep {
  return {
    work_id: workId,
    step_key: key,
    name: key,
    status: "pending",
    sort_order: 0,
    ...overrides,
  };
}

describe("work-watchdog", () => {
  beforeEach(() => {
    _resetWatchdog();
    _resetRunner();
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => {
    _resetWatchdog();
    _resetRunner();
    closeDb();
  });

  describe("findStalledWorks", () => {
    it("中间状态 + 最近步骤活动超过 10 分钟 → 判定停滞", () => {
      createWork(makeWork("w_stall", "assetting", minutesAgo(60)), [
        makeStep("w_stall", "research", { status: "done", completed_at: minutesAgo(30) }),
        makeStep("w_stall", "assets", { status: "active", started_at: minutesAgo(20) }),
      ]);
      const stalled = findStalledWorks(NOW);
      expect(stalled).toHaveLength(1);
      expect(stalled[0].id).toBe("w_stall");
      expect(stalled[0].status).toBe("assetting");
      expect(stalled[0].lastActivity).toBe(minutesAgo(20));
    });

    it("中间状态但刚活跃（2 分钟前）→ 不停滞", () => {
      createWork(makeWork("w_fresh", "planning", minutesAgo(30)), [
        makeStep("w_fresh", "plan", { status: "active", started_at: minutesAgo(2) }),
      ]);
      expect(findStalledWorks(NOW)).toHaveLength(0);
    });

    it("终态/非中间状态作品即使很旧也不报（reviewing/published/failed/draft）", () => {
      const old = minutesAgo(24 * 60);
      for (const [id, status] of [
        ["w_rev", "reviewing"],
        ["w_pub", "published"],
        ["w_fail", "failed"],
        ["w_draft", "draft"],
      ] as Array<[string, DbWork["status"]]>) {
        createWork(makeWork(id, status, old), [
          makeStep(id, "research", { status: "done", completed_at: old }),
        ]);
      }
      expect(findStalledWorks(NOW)).toHaveLength(0);
    });

    it("无步骤的中间状态作品 → 用 works.updated_at 判断", () => {
      createWork(makeWork("w_nostep_old", "researching", minutesAgo(30)), []);
      createWork(makeWork("w_nostep_new", "researching", minutesAgo(5)), []);
      const stalled = findStalledWorks(NOW);
      expect(stalled.map((s) => s.id)).toEqual(["w_nostep_old"]);
      expect(stalled[0].lastActivity).toBe(minutesAgo(30));
    });

    it("混合格式：步骤为 datetime('now') 空格格式、updated_at 为 ISO → 比较正确", () => {
      // 步骤活动时间很旧（空格格式），但 updated_at 很新（ISO）→ 不停滞。
      // 若把空格格式当本地时间解析或解析失败，这里会误判为停滞。
      createWork(makeWork("w_mix", "assembling", minutesAgo(1)), [
        makeStep("w_mix", "assembly", {
          status: "active",
          started_at: spaceFormat(minutesAgo(120)),
        }),
      ]);
      expect(findStalledWorks(NOW)).toHaveLength(0);
    });

    it("混合格式反向：updated_at 旧（ISO），步骤 started_at 新（空格格式）→ 不停滞", () => {
      createWork(makeWork("w_mix2", "assetting", minutesAgo(90)), [
        makeStep("w_mix2", "assets", {
          status: "active",
          started_at: spaceFormat(minutesAgo(3)),
        }),
      ]);
      expect(findStalledWorks(NOW)).toHaveLength(0);
    });

    it("空格格式的旧活动也能被正确判定为停滞", () => {
      createWork(makeWork("w_space_stall", "planning", spaceFormat(minutesAgo(45))), [
        makeStep("w_space_stall", "research", {
          status: "done",
          completed_at: spaceFormat(minutesAgo(40)),
        }),
      ]);
      const stalled = findStalledWorks(NOW);
      expect(stalled.map((s) => s.id)).toEqual(["w_space_stall"]);
      // lastActivity 保留原始字符串格式
      expect(stalled[0].lastActivity).toBe(spaceFormat(minutesAgo(40)));
    });

    it("边界：恰好 10 分钟不算停滞，超过 1 毫秒算停滞", () => {
      createWork(makeWork("w_edge_eq", "researching", minutesAgo(10)), []);
      createWork(makeWork("w_edge_over", "researching", new Date(NOW.getTime() - STALL_MS - 1).toISOString()), []);
      const stalled = findStalledWorks(NOW);
      expect(stalled.map((s) => s.id)).toEqual(["w_edge_over"]);
    });

    it("多步骤取最大活动时间：一个旧步骤 + 一个新步骤 → 不停滞", () => {
      createWork(makeWork("w_multi", "assetting", minutesAgo(50)), [
        makeStep("w_multi", "research", { status: "done", completed_at: minutesAgo(45) }),
        makeStep("w_multi", "assets", { status: "active", started_at: minutesAgo(4) }),
      ]);
      expect(findStalledWorks(NOW)).toHaveLength(0);
    });
  });

  describe("scan（_scanOnceForTest，不真实启动 setInterval）", () => {
    // scan 内部用真实时钟，夹具时间相对真实 now 构造
    const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

    it("停滞 + 会话已死 + 不在队列 → 自动入队", async () => {
      createWork(makeWork("w_stall", "assetting", realAgo(60 * 60_000)), []);
      await _scanOnceForTest({ isSessionAlive: () => false });
      const item = queueRepo.getItem("w_stall");
      expect(item).toBeDefined();
      expect(item?.status).toBe("queued");
    });

    it("停滞 + 会话仍存活 → 不动（只是慢）", async () => {
      createWork(makeWork("w_slow", "assetting", realAgo(60 * 60_000)), []);
      await _scanOnceForTest({ isSessionAlive: () => true });
      expect(queueRepo.getItem("w_slow")).toBeUndefined();
    });

    it("停滞 + 已在队列 → 不重复入队（position 不变）", async () => {
      createWork(makeWork("w_q", "planning", realAgo(60 * 60_000)), []);
      queueRepo.enqueue("w_q");
      const before = queueRepo.getItem("w_q");
      await _scanOnceForTest({ isSessionAlive: () => false });
      const after = queueRepo.getItem("w_q");
      expect(after?.position).toBe(before?.position);
      expect(after?.status).toBe("queued");
    });

    it("无停滞作品 → 不入队任何东西", async () => {
      createWork(makeWork("w_ok", "researching", realAgo(60_000)), []);
      await _scanOnceForTest({ isSessionAlive: () => false });
      expect(queueRepo.listQueue()).toHaveLength(0);
    });
  });

  describe("lastActivityOf", () => {
    it("取步骤与 updated_at 的最大值", () => {
      expect(
        lastActivityOf(minutesAgo(30), [minutesAgo(50), minutesAgo(5)]),
      ).toBe(minutesAgo(5));
    });

    it("全空 → null", () => {
      expect(lastActivityOf(null, [undefined, null])).toBeNull();
    });
  });

  describe("work-store listWorks 的 lastActivityAt", () => {
    it("无步骤作品 → lastActivityAt = updated_at", async () => {
      createWork(makeWork("w1", "draft", minutesAgo(7)), []);
      const works = await listWorks();
      const w1 = works.find((w) => w.id === "w1");
      expect(w1?.lastActivityAt).toBe(minutesAgo(7));
    });

    it("有步骤作品 → lastActivityAt 取步骤与 updated_at 的最大值", async () => {
      createWork(makeWork("w2", "assetting", minutesAgo(30)), [
        makeStep("w2", "research", { status: "done", completed_at: minutesAgo(20) }),
        makeStep("w2", "assets", { status: "active", started_at: minutesAgo(6) }),
      ]);
      const works = await listWorks();
      const w2 = works.find((w) => w.id === "w2");
      expect(w2?.lastActivityAt).toBe(minutesAgo(6));
    });

    it("混合格式步骤时间也参与比较（空格格式的新时间胜出，输出归一化为 ISO 带 Z）", async () => {
      createWork(makeWork("w3", "planning", minutesAgo(30)), [
        makeStep("w3", "plan", { status: "active", started_at: spaceFormat(minutesAgo(2)) }),
      ]);
      const works = await listWorks();
      const w3 = works.find((w) => w.id === "w3");
      // I6: 下发前归一化为 ISO 8601 带 Z（Safari 可解析、Chrome 无时区偏差）
      expect(w3?.lastActivityAt).toBe(new Date(minutesAgo(2)).toISOString());
    });
  });
});
