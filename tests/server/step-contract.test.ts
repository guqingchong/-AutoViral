/**
 * step-contract 阶段契约测试（2026-08-19 四项修复的回归保障）
 *
 * 背景:w_20260819_1634_cd5 素材搜索阶段 40 分钟空转、两轮驳回——
 * 根因是创作指令与评审 rubric 脱节、agent 不知 /api/stock-assets 端点。
 * 本测试锁定:指令必须含素材库端点与留痕要求;autoMode 禁止问用户;
 * 契约段必须与评审同读一份 criteria 文件。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildAssetConstraintSection,
  buildStepContractSection,
  buildMaterialSearchInstruction,
} from "../../src/server/step-contract.js";

const WORK = { id: "w_test_001", title: "城投转型测试", videoSearchQuery: "城投转型" };

describe("buildMaterialSearchInstruction", () => {
  it("必须告诉 agent 素材库服务端端点(key 服务端持有,禁止直连 Pexels)", () => {
    const s = buildMaterialSearchInstruction(WORK, true);
    expect(s).toContain("/api/stock-assets/search");
    expect(s).toContain("/api/stock-assets/download");
    expect(s).toContain("禁止直连 api.pexels.com");
  });

  it("执行要求与评审标准对齐:多组查询/下载校验/结构化留痕", () => {
    const s = buildMaterialSearchInstruction(WORK, true);
    expect(s).toContain("多组查询");
    expect(s).toContain("ffprobe");
    expect(s).toContain("material-candidates.md");
  });

  it("autoMode:自行选优,禁止问用户(修交互残留)", () => {
    const s = buildMaterialSearchInstruction(WORK, true);
    expect(s).toContain("禁止向用户提问");
    expect(s).not.toContain("请用户选定主素材");
  });

  it("交互模式:保留用户挑选环节", () => {
    const s = buildMaterialSearchInstruction(WORK, false);
    expect(s).toContain("请用户选定主素材");
  });

  it("videoSearchQuery 缺失时回落到作品标题", () => {
    const s = buildMaterialSearchInstruction({ id: "w_x", title: "标题即主题" }, true);
    expect(s).toContain('"标题即主题"');
  });
});

describe("buildStepContractSection", () => {
  it("与评审同源:注入 criteria/<step>.md 的验收标准原文", () => {
    const criteriaPath = join(homedir(), ".claude", "skills", "content-evaluator", "criteria", "material-search.md");
    let expected = "";
    try { expected = readFileSync(criteriaPath, "utf-8").trim(); } catch { /* 环境无文件则跳过断言 */ }
    const s = buildStepContractSection("material-search", {});
    if (expected) {
      expect(s).toContain("本阶段验收标准");
      expect(s).toContain(expected.slice(0, 60));
    }
  });

  it("默认含素材三维约束;includeAssets:false 时不重复注入", () => {
    const work = { assetSource: "smart", assetForm: "slides" };
    const withAssets = buildStepContractSection("plan", work);
    expect(withAssets).toContain("素材约束");
    expect(withAssets).toContain("精品混合");
    const without = buildStepContractSection("plan", work, { includeAssets: false });
    expect(without).not.toContain("素材约束");
  });

  it("无 criteria 文件的步骤不报错", () => {
    expect(() => buildStepContractSection("no-such-step", {})).not.toThrow();
  });
});

describe("buildAssetConstraintSection(迁出后行为不变)", () => {
  it("smart 路由 + 未选数字人 → 口播禁用数字人", () => {
    const s = buildAssetConstraintSection("video-mix", "smart", "eco", false);
    expect(s).toContain("镜头路由(smart)");
    expect(s).toContain("禁用数字人镜头");
  });

  it("三维全空仍输出程序化素材铁律", () => {
    const s = buildAssetConstraintSection();
    expect(s).toContain("程序化素材铁律");
  });
});
