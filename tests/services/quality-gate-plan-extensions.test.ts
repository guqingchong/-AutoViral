import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPlanGateExtensions, assertFactClaims } from "../../src/services/quality-gate.js";

// 2026-09-18 误报治理(w_20260918_1519_b44 BREAKPOINT 事件):
// assertPlanGateExtensions 此前用 assertFactClaims 扫 plan.md 全文,
// 说明性文字里的裸年份(「2026 年度」)被当口播断言误拦,烧掉一整轮。
// 修复:script.json 存在时口播断言由 assertScriptContract 覆盖,plan.md 不再扫;
// 全文日期形式(2026年9月7日)显式豁免。旧五步流水线(无 script.json)保留 plan.md 兜底扫描。

describe("assertPlanGateExtensions 事实断言扫描收窄", () => {
  let root: string;
  let n = 0;
  let dir: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "av-fclaims-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const fresh = async () => {
    dir = join(root, `case-${++n}`);
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "plan.md"), "# 分镜\n", "utf-8");
    return dir;
  };

  it("script.json 存在时,plan.md 说明性文字的裸年份不再误拦", async () => {
    await fresh();
    await writeFile(join(dir, "plan.md"), "说明:十五五规划纲要(2026 年度)为宏观背景,不进成片。\n", "utf-8");
    await writeFile(join(dir, "assets", "script.json"), JSON.stringify({
      scenes: [{ i: 1, narration: "城市经营的关键是留住人。" }],
    }), "utf-8");
    expect(assertPlanGateExtensions(dir).filter((i) => i.key === "claim_unverified")).toEqual([]);
  });

  it("script.json 缺失时(旧五步流水线),plan.md 口播断言仍兜底拦截", async () => {
    await fresh();
    await writeFile(join(dir, "plan.md"), "镜1:根据建科〔2024〕150号文要求推进城市更新。\n", "utf-8");
    expect(assertPlanGateExtensions(dir).map((i) => i.key)).toContain("claim_unverified");
  });

  it("日期形式豁免:2026年9月7日 不是裸年份断言", () => {
    expect(assertFactClaims("会议于 2026年9月7日 召开。")).toEqual([]);
    // 裸年份仍然拦截
    expect(assertFactClaims("2026 年城镇化率持续提升。").map((i) => i.key)).toContain("claim_unverified");
  });
});
