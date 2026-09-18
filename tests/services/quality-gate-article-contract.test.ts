import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArticleContract, assertScriptContract } from "../../src/services/quality-gate.js";

// 2026-09-10 定位修正(业主实测意见):article.md 是纯粹的深度研究文章,
// 口播预算/朗读时长校验迁至 plan-assets 的 assertScriptContract。
// 文章契约保留:字段/核验覆盖/断言来源标注/wordCount 自洽/篇幅下限/锚点/type 白名单。
describe("assertArticleContract 研究文章契约(定位修正后)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-contract-"));
    mkdirSync(join(workDir, "research"), { recursive: true });
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  /** 全文 14 字:标题 2 +「一、开场」3 +「收入下降」4 +「二、收尾」3 +「明显」2(锚点标记不计) */
  const MD = `# 标题

## 一、开场(锚点 sec-1)

收入下降。

## 二、收尾(锚点 sec-2)

明显。
`;

  function writeJson(obj: unknown) {
    writeFileSync(join(workDir, "research", "article.json"), JSON.stringify(obj));
  }
  function writeMd(text = MD) {
    writeFileSync(join(workDir, "research", "article.md"), text);
  }
  const baseJson = {
    title: "t",
    wordCount: 14,
    facts: [{ text: "f", type: "数据", verify_status: "已核验", source_url: "https://a.b/c" }],
    feasibility: { verdict: "可行" },
    sections: [
      { anchor: "sec-1", heading: "开场", summary: "收入下降" },
      { anchor: "sec-2", heading: "收尾", summary: "明显" },
    ],
    factTypeLegend: { 数据: "数值类", 文号: "政策文号" },
  };

  it("自洽样本不产生契约 issue(quick 档不限篇幅)", () => {
    writeJson(baseJson);
    writeMd();
    const issues = assertArticleContract(workDir, "quick");
    expect(issues.filter((i) => i.key.startsWith("article_"))).toEqual([]);
  });

  it("speechBudget 不再是必填字段(缺失不报 fields_missing)", () => {
    writeJson(baseJson); // baseJson 本就没有 speechBudget
    writeMd();
    const keys = assertArticleContract(workDir, "quick").map((i) => i.key);
    expect(keys).not.toContain("article_fields_missing");
  });

  it("存量契约含 speechBudget 兼容忽略(不报错)", () => {
    writeJson({ ...baseJson, speechBudget: { maxChars: 4, estimatedSpeechS: 99 } });
    writeMd();
    const issues = assertArticleContract(workDir, "quick");
    expect(issues.filter((i) => i.key.startsWith("article_"))).toEqual([]);
  });

  it("wordCount 声明与文章实测偏差>15% → article_wordcount_mismatch", () => {
    writeJson({ ...baseJson, wordCount: 100 }); // 实测 8
    writeMd();
    const issues = assertArticleContract(workDir, "quick");
    expect(issues.some((i) => i.key === "article_wordcount_mismatch")).toBe(true);
  });

  it("full 档篇幅低于下限 → article_length_below_depth", () => {
    writeJson({ ...baseJson, wordCount: 14 });
    writeMd(); // 14 字 << 2000
    const issues = assertArticleContract(workDir, "full");
    expect(issues.some((i) => i.key === "article_length_below_depth" && i.detail.includes("2000"))).toBe(true);
  });

  it("standard 档篇幅下限 960,quick 档不查", () => {
    writeJson(baseJson);
    writeMd();
    expect(assertArticleContract(workDir, "standard").some((i) => i.key === "article_length_below_depth" && i.detail.includes("960"))).toBe(true);
    expect(assertArticleContract(workDir, "quick").some((i) => i.key === "article_length_below_depth")).toBe(false);
  });

  it("sections 锚点在正文缺失 → article_anchor_missing", () => {
    writeJson({ ...baseJson, sections: [{ anchor: "sec-99", heading: "不存在", summary: "x" }] });
    writeMd();
    const issues = assertArticleContract(workDir, "quick");
    expect(issues.some((i) => i.key === "article_anchor_missing" && i.detail.includes("sec-99"))).toBe(true);
  });

  it("facts.type 不在 factTypeLegend → article_fact_type_unknown", () => {
    writeJson({
      ...baseJson,
      facts: [{ text: "f", type: "心情", verify_status: "已核验", source_url: "https://a.b/c" }],
    });
    writeMd();
    const issues = assertArticleContract(workDir, "quick");
    expect(issues.some((i) => i.key === "article_fact_type_unknown" && i.detail.includes("心情"))).toBe(true);
  });
});

describe("assertScriptContract 口播脚本契约(plan-assets)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-script-"));
    mkdirSync(join(workDir, "assets"), { recursive: true });
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function writeScript(obj: unknown) {
    writeFileSync(join(workDir, "assets", "script.json"), JSON.stringify(obj));
  }
  const goodScript = {
    scenes: [
      { i: 1, source_section: "sec-1", narration: "官方明说了,土地财政难以为继。" },
      { i: 2, source_section: "sec-2", narration: "钱从哪来,这是每个城投人的饭碗线。" },
    ],
  };

  it("script.json 缺失 → 无 issue(由 assertContractArtifacts 拦截)", () => {
    expect(assertScriptContract(workDir, 180)).toEqual([]);
  });

  it("合规脚本 → 无 issue", () => {
    writeScript(goodScript);
    expect(assertScriptContract(workDir, 180)).toEqual([]);
  });

  it("scenes 为空 → script_scenes_empty", () => {
    writeScript({ scenes: [] });
    expect(assertScriptContract(workDir, 180).map((i) => i.key)).toContain("script_scenes_empty");
  });

  it("旁白缺 source_section → script_anchor_missing", () => {
    writeScript({ scenes: [{ i: 1, narration: "没有锚点。" }] });
    const issues = assertScriptContract(workDir, 180);
    expect(issues.some((i) => i.key === "script_anchor_missing")).toBe(true);
  });

  it("旁白含未核验文号 → claim_unverified(待核禁进口播落在脚本)", () => {
    writeScript({ scenes: [{ i: 1, source_section: "sec-1", narration: "根据建科〔2024〕150号文要求推进。" }] });
    const issues = assertScriptContract(workDir, 180);
    expect(issues.some((i) => i.key === "claim_unverified")).toBe(true);
  });

  it("朗读实测超目标时长×1.2 → script_duration_overflow", () => {
    // 1000 朗读字符 ÷4.5 ≈ 222s > 10s×1.2
    writeScript({ scenes: [{ i: 1, source_section: "sec-1", narration: "字".repeat(1000) }] });
    const issues = assertScriptContract(workDir, 10);
    expect(issues.some((i) => i.key === "script_duration_overflow")).toBe(true);
  });

  it("未传目标时长 → 不查时长(结构仍查)", () => {
    writeScript({ scenes: [{ i: 1, source_section: "sec-1", narration: "字".repeat(1000) }] });
    const issues = assertScriptContract(workDir);
    expect(issues.some((i) => i.key === "script_duration_overflow")).toBe(false);
  });

  it("数字朗读膨胀被时长检查捕获(汉字口径会漏)", () => {
    // 「41518亿元」汉字 2 字,朗读 7 字;50 句 ≈ 350 朗读字符 ≈ 78s > 60s×1.2? 78>72 触发
    writeScript({ scenes: [{ i: 1, source_section: "sec-1", narration: "41518亿元。".repeat(50) }] });
    const issues = assertScriptContract(workDir, 60);
    expect(issues.some((i) => i.key === "script_duration_overflow")).toBe(true);
  });
});
