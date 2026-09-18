import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// dataDir 在 config.ts 模块加载时定型,必须在任何 src import 之前指向临时目录。
vi.hoisted(() => {
  const base = process.env.TEMP ?? process.env.TMP ?? "/tmp";
  process.env.AUTOVIRAL_DATA_DIR = `${base}/av-forcepass-${process.pid}-${Date.now()}`;
});

vi.mock("../../src/db/migrate-legacy.js", () => ({
  migrateLegacyWorks: vi.fn(async () => 0),
}));

import { Hono } from "hono";
import { apiRoutes } from "../../src/server/api.js";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork, getWorkSteps } from "../../src/db/works-repo.js";
import { _resetRunner } from "../../src/services/work-queue.js";
import { _resetWatchdog } from "../../src/services/work-watchdog.js";
import type { DbWork, DbPipelineStep } from "../../src/db/types.js";

function makeApp() {
  const app = new Hono();
  app.route("/", apiRoutes);
  return app;
}

function blockedWork(id: string) {
  const now = new Date().toISOString();
  const work: DbWork = {
    id, title: `作品 ${id}`, type: "short-video", status: "assetting",
    platforms: ["douyin"], evaluation_mode: false, tags: [], created_at: now, updated_at: now,
  };
  const steps: DbPipelineStep[] = (["research", "plan", "assets", "assembly"] as const).map((key, idx) => ({
    work_id: id, step_key: key, name: key,
    status: (key === "assets" ? "eval_blocked" : key === "assembly" ? "pending" : "done") as DbPipelineStep["status"],
    started_at: now, completed_at: key === "assets" || key === "assembly" ? null : now, sort_order: idx,
  }));
  return { work, steps };
}

/** 写一份最新评审结果(含 major/minor 未修复问题) */
async function writeEval(workId: string) {
  const dir = join(process.env.AUTOVIRAL_DATA_DIR!, "works", workId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "eval-assets-1.json"), JSON.stringify({
    step: "assets", attempt: 1, verdict: "fail",
    scores: {}, suggestions: [], timestamp: new Date().toISOString(),
    issues: [
      { severity: "minor", description: "字幕 CPS 略高" },
      { severity: "major", description: "镜38 遮罩覆盖不足:遮罩仅 37% 渐变" },
      { severity: "critical", description: "画面 4.4万亿 vs 旁白 4万亿" },
    ],
  }));
}

// 2026-09-11(assets 复盘改进点 1):force-pass 是带病放行通道——
// 最新评审仍有未修复 issues 时必须 409 返回清单,逐条确认后 confirm:true 才放行。
describe("POST /api/works/:id/eval/force-pass — 带病放行逐条确认", () => {
  let app: Hono;

  beforeEach(() => {
    _resetRunner();
    _resetWatchdog();
    resetInMemoryDb();
    migrate();
    app = makeApp();
  });

  afterAll(async () => {
    closeDb();
    await rm(process.env.AUTOVIRAL_DATA_DIR!, { recursive: true, force: true }).catch(() => {});
  });

  it("有未修复 issues 且无 confirm → 409 返回清单(critical 置顶),状态不变", async () => {
    const { work, steps } = blockedWork("w_fp1");
    createWork(work, steps);
    await writeEval("w_fp1");

    const res = await app.request("/api/works/w_fp1/eval/force-pass", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "assets" }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe("force_pass_confirm_required");
    expect(data.issues).toHaveLength(3);
    expect(data.issues[0].severity).toBe("critical"); // 红字置顶排序
    expect(data.issues[1].severity).toBe("major");
    // 步骤状态未被放行
    const w = getWorkSteps("w_fp1");
    expect(w.find((p) => p.step_key === "assets")?.status).toBe("eval_blocked");
  });

  it("confirm:true → 放行,步骤置 done 并激活下一步", async () => {
    const { work, steps } = blockedWork("w_fp2");
    createWork(work, steps);
    await writeEval("w_fp2");

    const res = await app.request("/api/works/w_fp2/eval/force-pass", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "assets", nextStep: "assembly", confirm: true }),
    });
    expect(res.status).toBe(200);
    const w = getWorkSteps("w_fp2");
    expect(w.find((p) => p.step_key === "assets")?.status).toBe("done");
    expect(w.find((p) => p.step_key === "assembly")?.status).toBe("active");
  });

  it("confirm:true 且下一步是 assets → 触发 H3 开机提醒钩子(静默,不阻断放行)", async () => {
    const { work, steps } = blockedWork("w_fp4");
    // plan 受阻,下一步 assets
    for (const s of steps) {
      if (s.step_key === "plan") s.status = "eval_blocked" as never;
      else s.status = (s.step_key === "research" ? "done" : "pending") as never;
    }
    createWork(work, steps);

    const res = await app.request("/api/works/w_fp4/eval/force-pass", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "plan", nextStep: "assets", confirm: true }),
    });
    expect(res.status).toBe(200);
    const ws = getWorkSteps("w_fp4");
    expect(ws.find((p) => p.step_key === "plan")?.status).toBe("done");
    expect(ws.find((p) => p.step_key === "assets")?.status).toBe("active");
    // 提醒钩子为 fire-and-forget,等一拍确保动态 import 无异常即算走通
    await new Promise((r) => setTimeout(r, 300));
  });

  it("无评审问题(无 eval 文件)→ 无需 confirm 直接放行", async () => {
    const { work, steps } = blockedWork("w_fp3");
    createWork(work, steps);

    const res = await app.request("/api/works/w_fp3/eval/force-pass", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "assets" }),
    });
    expect(res.status).toBe(200);
    expect(getWorkSteps("w_fp3").find((p) => p.step_key === "assets")?.status).toBe("done");
  });
});
