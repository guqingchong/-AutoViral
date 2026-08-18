/**
 * 04 方案用途机制测试（2026-08-18）：预设完整性 / 技能包去重加权 / prompt 注入。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AUTOVIRAL_DATA_DIR = mkdtempSync(join(tmpdir(), "purpose-test-"));

import { migrate } from "../../src/db/migrate.js";
import { PURPOSE_PRESETS, CONTENT_FORMS, getPurpose, purposeEvalFocusBlock } from "../../src/services/purpose-presets.js";
import { addPurposeSkill, listPurposeSkills, purposeSkillsBlock, countPurposeSkills } from "../../src/db/purpose-skills-repo.js";

beforeAll(() => migrate());

describe("purpose-presets", () => {
  it("六用途齐备且引用的内容形式都存在", () => {
    expect(PURPOSE_PRESETS.map((p) => p.key)).toEqual([
      "grow_fans", "sell_products", "drive_traffic", "brand_exposure", "authority", "short_drama",
    ]);
    for (const p of PURPOSE_PRESETS) {
      expect(p.forms.length).toBeGreaterThan(0);
      for (const f of p.forms) expect(CONTENT_FORMS[f], `${p.key} 引用了未定义形式 ${f}`).toBeDefined();
      expect(p.promptBlock).toContain("用途约束");
      expect(p.evalFocus.length).toBeGreaterThan(0);
    }
  });

  it("内容形式全集 13 种", () => {
    expect(Object.keys(CONTENT_FORMS)).toHaveLength(13);
  });

  it("evalFocusBlock:有用途给差异化评审点,无用途空串", () => {
    expect(purposeEvalFocusBlock("short_drama")).toContain("扣子");
    expect(purposeEvalFocusBlock(undefined)).toBe("");
    expect(purposeEvalFocusBlock("nonexistent")).toBe("");
  });
});

describe("purpose-skills repo", () => {
  it("新增/去重加权/注入文本", () => {
    expect(addPurposeSkill({ purpose: "short_drama", skill: "前3秒必须冲突锚定", source: "调研" }).added).toBe(true);
    // 重复:不新增,权重 +0.1
    expect(addPurposeSkill({ purpose: "short_drama", skill: "前3秒必须冲突锚定" }).added).toBe(false);
    addPurposeSkill({ purpose: "short_drama", skill: "每集结尾留扣子" });
    expect(countPurposeSkills("short_drama")).toBe(2);

    const skills = listPurposeSkills("short_drama");
    expect(skills).toHaveLength(2);
    expect(skills[0].weight).toBeCloseTo(1.1); // 重复命中的排前(权重高)

    const block = purposeSkillsBlock("short_drama");
    expect(block).toContain("用途技能包");
    expect(block).toContain("前3秒必须冲突锚定");
    expect(purposeSkillsBlock("grow_fans")).toBe(""); // 空用途返回空串
  });
});
