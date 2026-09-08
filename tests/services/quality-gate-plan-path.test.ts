import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPlanDeliverables, assertPlanReferences } from "../../src/services/quality-gate.js";

// P5 修复:v2 契约要求写 plan/plan.md,门禁候选路径必须覆盖
describe("assertPlanDeliverables 分镜文档定位(P5)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "av-plan-gate-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // 一个能过门禁的最小分镜文档(无旁白、无表也能过——拿不到 5 个镜头不出具时长结论)
  const planDoc = "# 分镜\n\n| 镜号 | 画面 | 时长 |\n| --- | --- | --- |\n| 01 | 开场 | 3s |\n";

  it("plan/plan.md 存在(v2 契约路径)→ 无 plan_doc issue", async () => {
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFile(join(dir, "plan", "plan.md"), planDoc, "utf-8");
    const keys = assertPlanDeliverables(dir).map((i) => i.key);
    expect(keys).not.toContain("plan_doc");
  });

  it("根目录 plan.md 存在 → 无 plan_doc issue", async () => {
    await writeFile(join(dir, "plan.md"), planDoc, "utf-8");
    const keys = assertPlanDeliverables(dir).map((i) => i.key);
    expect(keys).not.toContain("plan_doc");
  });

  it("assets/plan-storyboard.md 存在 → 无 plan_doc issue", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "plan-storyboard.md"), planDoc, "utf-8");
    const keys = assertPlanDeliverables(dir).map((i) => i.key);
    expect(keys).not.toContain("plan_doc");
  });

  it("三个位置都不存在 → plan_doc issue", () => {
    const keys = assertPlanDeliverables(dir).map((i) => i.key);
    expect(keys).toContain("plan_doc");
  });
});

// B12:assertPlanReferences 的 known 集并入 registry.json sources[].name
describe("assertPlanReferences registry 核验(B12)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "av-planref-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writePlanAndRegistry(planText: string, registry?: unknown) {
    await mkdir(join(dir, "plan"), { recursive: true });
    await writeFile(join(dir, "plan", "plan.md"), planText, "utf-8");
    if (registry !== undefined) {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(join(dir, "assets", "registry.json"), JSON.stringify(registry), "utf-8");
    }
  }

  it("registry 有登记但 candidates 未列的引用可通过", async () => {
    await writePlanAndRegistry(
      "| 镜号 | 素材 |\n| --- | --- |\n| 01 | shot-01.mp4 |",
      { sources: [{ name: "shot-01.mp4", type: "video", source_url: "https://x" }] },
    );
    expect(assertPlanReferences(dir)).toEqual([]);
  });

  it("registry 与 candidates 都无的引用被拦", async () => {
    await writePlanAndRegistry(
      "| 镜号 | 素材 |\n| --- | --- |\n| 01 | ghost-99.mp4 |",
      { sources: [{ name: "shot-01.mp4", type: "video" }] },
    );
    const keys = assertPlanReferences(dir).map((i) => i.key);
    expect(keys).toContain("plan_ref_missing");
  });
});
