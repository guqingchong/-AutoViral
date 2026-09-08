import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertArticleContract, assertContractArtifacts } from "../../src/services/quality-gate.js";

// 流水线 v2 批次2:内容研究文章契约门禁
describe("assertArticleContract(流水线 v2)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-article-gate-"));
    await mkdir(join(dir, "research"), { recursive: true });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const goodArticle = {
    version: 1, title: "测试文章", depth: "standard", wordCount: 500,
    speechBudget: { charsPerSec: 4.5, targetDurationS: 180, maxChars: 810 },
    facts: [
      { text: "某政策 2023 年印发", type: "年份", verify_status: "已核验", source_url: "https://www.gov.cn/x" },
      { text: "占比 12%", type: "百分比", verify_status: "已核验", source_url: "https://stats.gov.cn/y" },
    ],
    feasibility: { verdict: "feasible", materialRisks: [], notes: "" },
    sections: [{ heading: "背景", summary: "…", anchor: "sec-1" }],
  };

  async function writeBoth(article: unknown, md: string) {
    await writeFile(join(dir, "research", "article.json"), JSON.stringify(article), "utf-8");
    await writeFile(join(dir, "research", "article.md"), md, "utf-8");
  }

  it("合规文章 → 无 issue", async () => {
    await writeBoth(goodArticle, "这是一篇没有事实断言的正文。");
    expect(assertArticleContract(dir, "standard")).toEqual([]);
  });

  it("缺关键字段 → fail", async () => {
    await writeBoth({ title: "只有标题" }, "正文。");
    const keys = assertArticleContract(dir, "standard").map((i) => i.key);
    expect(keys).toContain("article_fields_missing");
  });

  it("facts 核验覆盖率不足 standard 档 80% → fail", async () => {
    const a = { ...goodArticle, facts: [
      { text: "A 2023 年", verify_status: "已核验", source_url: "https://www.gov.cn/x" },
      { text: "B 12%", verify_status: "待核", source_url: "https://a.b/c" },
      { text: "C 30%", verify_status: "待核", source_url: "https://a.b/d" },
    ] };
    await writeBoth(a, "正文。");
    const keys = assertArticleContract(dir, "standard").map((i) => i.key);
    expect(keys).toContain("article_facts_unverified");
  });

  it("full 档要求 100% 已核验", async () => {
    const a = { ...goodArticle, facts: [
      { text: "A 2023 年", verify_status: "已核验", source_url: "https://www.gov.cn/x" },
      { text: "B 12%", verify_status: "待核", source_url: "https://a.b/c" },
    ] };
    await writeBoth(a, "正文。");
    expect(assertArticleContract(dir, "full").map((i) => i.key)).toContain("article_facts_unverified");
  });

  it("字数超语速预算 ×1.2 → fail", async () => {
    await writeBoth({ ...goodArticle, wordCount: 2000 }, "正文。");
    expect(assertArticleContract(dir, "standard").map((i) => i.key)).toContain("article_budget_mismatch");
  });

  it("article.md 含未核验文号 → fail(assertFactClaims 联动)", async () => {
    await writeBoth(goodArticle, "根据建科〔2024〕150号文的要求,城市更新全面推进。");
    expect(assertArticleContract(dir, "standard").map((i) => i.key)).toContain("claim_unverified");
  });
});

describe("assertContractArtifacts(流水线 v2 两新步)", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "av-contract-v2-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("content-research 缺 article.md/article.json → 两条 issue", async () => {
    const issues = assertContractArtifacts(dir, "content-research");
    expect(issues.map((i) => i.key).sort()).toEqual(["contract_article_json_missing", "contract_article_md_missing"]);
  });

  it("plan-assets 缺 script/registry/candidates → 三条 issue", async () => {
    const issues = assertContractArtifacts(dir, "plan-assets");
    expect(issues.map((i) => i.key).sort()).toEqual(["contract_candidates_missing", "contract_registry_missing", "contract_script_missing"]);
  });

  it("文件齐备 → 无 issue", async () => {
    await mkdir(join(dir, "research"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "research", "article.md"), "x", "utf-8");
    await writeFile(join(dir, "research", "article.json"), "{}", "utf-8");
    await writeFile(join(dir, "assets", "script.json"), "{}", "utf-8");
    await writeFile(join(dir, "assets", "registry.json"), "{}", "utf-8");
    await writeFile(join(dir, "assets", "material-candidates.md"), "x", "utf-8");
    expect(assertContractArtifacts(dir, "content-research")).toEqual([]);
    expect(assertContractArtifacts(dir, "plan-assets")).toEqual([]);
  });
});
