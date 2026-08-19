import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P2-T1 验收:评审 3 轮不过 → eval_blocked。2026-08-19 P4-T2 后 CLI 评审路径删除,
// 改为 mock runApiEvaluator(动态 import 会被 vi.mock 拦截);fake 会话必须带 loop 标记。

vi.mock("../../src/agent/evaluator.js", () => ({
  runApiEvaluator: vi.fn(async () => ({
    step: "research", attempt: 1, verdict: "fail" as const,
    scores: { 相关性: 3 },
    issues: [{ severity: "critical", description: "测试:内容不达标" }],
    suggestions: ["重写"],
    timestamp: new Date().toISOString(),
  })),
}));

describe("eval_blocked 三轮卡死复现", () => {
  let dir: string;
  let apiRoutes: any;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-evalblocked-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    const api = await import("../../src/server/api.js");
    apiRoutes = api.apiRoutes;

    const fakeSession = {
      workId: "", messageHistory: [], browserSockets: new Set(),
      idle: true, evalStep: undefined as string | undefined,
      loop: {}, // P4-T2:runEvaluation 要求 API loop 会话(CLI 路径已删)
    };
    api.setWsBridge({
      getSession: () => undefined,
      ensureSession: (workId: string) => ({ ...fakeSession, workId, messageHistory: [] }),
      sendMessage: vi.fn(async () => true),
      broadcastToBrowsers: vi.fn(),
    } as never);
  });

  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  async function waitStepStatus(workId: string, step: string, want: string, timeoutMs = 8000): Promise<string> {
    const { getWork } = await import("../../src/work-store.js");
    const start = Date.now();
    for (;;) {
      const w = await getWork(workId);
      const st = w?.pipeline[step]?.status;
      if (st === want) return st;
      if (Date.now() - start > timeoutMs) throw new Error(`等待 ${step}=${want} 超时,当前=${st}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  it("评审连续 3 轮 fail → 第 3 轮后 eval_blocked,前 2 轮回退 active", async () => {
    const { createWork, getWork } = await import("../../src/work-store.js");
    const work = await createWork({
      title: "eval_blocked 测试", type: "short-video", platforms: ["douyin"],
      evaluationMode: true,
    } as never);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await apiRoutes.request(`/api/works/${work.id}/pipeline/advance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completedStep: "research", nextStep: "plan" }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).evaluating).toBe(true);
      // 前 2 轮 fail → 回退 active 等修复;第 3 轮 → eval_blocked
      await waitStepStatus(work.id, "research", attempt < 3 ? "active" : "eval_blocked");
    }

    const { runApiEvaluator } = await import("../../src/agent/evaluator.js");
    expect(runApiEvaluator).toHaveBeenCalledTimes(3);
    const w = await getWork(work.id);
    expect(w?.pipeline.research.status).toBe("eval_blocked");
    // 评审进行中重复 advance 被守卫 409 拦截(evaluating 态)——附带回归
  }, 30_000);
});
