/**
 * template-generator 超时契约测试（2026-08-19 根因修复回归）
 *
 * 根因:deepseek-v4-flash 生成 3 个模板实测耗时 270~320s,
 * 旧 timeoutMs=300_000 压在耗时分布中间 → 高峰期 3 次重试全部超时,
 * 用户看到 "This operation was aborted"。
 * 契约:批量生成调用必须给 ≥600s 超时,且重试次数受限(避免 30min+ 静默等待)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runJsonPrompt = vi.fn();
vi.mock("../../src/services/llm-json.js", () => ({
  runJsonPrompt: (...args: unknown[]) => runJsonPrompt(...args),
  extractJsonFromText: (t: string) => JSON.parse(t),
}));

vi.mock("../../src/db/templates-repo.js", () => ({
  createTemplate: (t: Record<string, unknown>) => t,
  getTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  listTopUsedTemplates: () => [],
  deleteTemplate: vi.fn(),
}));

vi.mock("../../src/db/template-skills-repo.js", () => ({
  listSkills: () => [],
  touchSkill: vi.fn(),
}));

vi.mock("../../src/services/template-quality.js", () => ({
  checkTemplateQuality: () => [],
}));

vi.mock("../../src/services/template-score.js", () => ({
  scoreTemplate: () => ({ score: 80, issues: [] }),
}));

vi.mock("../../src/config.js", () => ({
  dataDir: () => "C:/tmp/autoviral-test",
}));

import { generateTemplates } from "../../src/services/template-generator.js";

const RAW_TEMPLATE = {
  name: "测试模板",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0a0a0a" },
  variables: [{ name: "topic", type: "text", default: "示例", label: "主题" }],
  layers: [
    { id: "t1", type: "text", content: "{{topic}}", fontSize: 60, color: "#ffffff", align: "center", start: 0, duration: 5, position: { x: 100, y: 400 } },
  ],
  audio: [],
  transitions: [],
};

describe("generateTemplates LLM 超时契约", () => {
  beforeEach(() => {
    runJsonPrompt.mockReset();
    runJsonPrompt.mockResolvedValue({ templates: [RAW_TEMPLATE] });
  });

  it("批量生成调用使用 ≥600s 超时（覆盖 deepseek 思考型模型 270~320s 实测耗时）", async () => {
    await generateTemplates({ count: 1 });
    expect(runJsonPrompt).toHaveBeenCalledTimes(1);
    const [, opts] = runJsonPrompt.mock.calls[0] as [string, { timeoutMs?: number; maxAttempts?: number }];
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it("批量生成限制重试次数（超时类失败不应静默等待 30 分钟以上）", async () => {
    await generateTemplates({ count: 1 });
    const [, opts] = runJsonPrompt.mock.calls[0] as [string, { timeoutMs?: number; maxAttempts?: number }];
    expect(opts.maxAttempts).toBeLessThanOrEqual(2);
  });
});
