import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 流水线 v2 批次2:/pipeline/regress 回退通道集成测试
// 白名单/版本守卫/gaps 前置/幂等/状态迁移/3 次转人工
describe("pipeline regress 回退通道(流水线 v2)", () => {
  let dir: string;
  let apiRoutes: any;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-regress-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    const api = await import("../../src/server/api.js");
    apiRoutes = api.apiRoutes;
    api.setWsBridge({
      getSession: () => undefined,
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

  async function makeV2Work() {
    const { createWork } = await import("../../src/work-store.js");
    return createWork({ title: "regress 测试", type: "short-video", platforms: ["douyin"] } as never);
  }

  function regressCall(id: string, body: unknown) {
    return apiRoutes.request(`/api/works/${id}/pipeline/regress`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("白名单:非 plan-assets→content-research 的边被拒", async () => {
    const w = await makeV2Work();
    const res = await regressCall(w.id, { fromStep: "assets", toStep: "plan-assets" });
    expect(res.status).toBe(400);
  });

  it("v1 作品(旧五步)被拒", async () => {
    const { createWork } = await import("../../src/work-store.js");
    const w = await createWork({ title: "v1", type: "short-video", platforms: ["douyin"], explicitParams: { pipelineVersion: 1 } } as never);
    const res = await regressCall(w.id, { fromStep: "plan-assets", toStep: "content-research" });
    expect(res.status).toBe(400);
  });

  it("缺 material-gaps.json 被拒;补齐后回退成功且状态迁移正确", async () => {
    const w = await makeV2Work();
    // 无 gaps → 400
    expect((await regressCall(w.id, { fromStep: "plan-assets", toStep: "content-research" })).status).toBe(400);
    // 模拟走到 plan-assets:content-research 已完成、plan-assets 进行中
    const { getWork, updateWork } = await import("../../src/work-store.js");
    const cur = (await getWork(w.id))!;
    cur.pipeline["content-research"].status = "done";
    cur.pipeline["plan-assets"].status = "active";
    await updateWork(w.id, { pipeline: cur.pipeline } as never);
    // 补 gaps → 回退成功
    const gapsDir = join(dir, "works", w.id, "assets");
    await mkdir(gapsDir, { recursive: true });
    await writeFile(join(gapsDir, "material-gaps.json"), JSON.stringify({ gaps: [{ scene: "S3", needed: "实拍", triedQueries: ["x"], conclusion: "无" }], requestedAt: new Date().toISOString() }), "utf-8");
    const res = await regressCall(w.id, { fromStep: "plan-assets", toStep: "content-research", reason: "整段缺素材", gapsRef: "assets/material-gaps.json" });
    expect(res.status).toBe(200);
    const after = await getWork(w.id);
    expect(after?.pipeline["content-research"].status).toBe("active");
    expect(after?.pipeline["content-research"].note).toContain("regress#1");
    expect(after?.pipeline["plan-assets"].status).toBe("pending");
    expect(after?.status).toBe("researching");
  });

  it("幂等:已在 content-research 时重复回退 → 409", async () => {
    const w = await makeV2Work(); // 新建作品 content-research 本就是 active
    const gapsDir = join(dir, "works", w.id, "assets");
    await mkdir(gapsDir, { recursive: true });
    await writeFile(join(gapsDir, "material-gaps.json"), "{}", "utf-8");
    const res = await regressCall(w.id, { fromStep: "plan-assets", toStep: "content-research" });
    expect(res.status).toBe(409);
  });
});
