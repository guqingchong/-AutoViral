import { describe, it, expect } from "vitest";
import { buildTonePrompt } from "../../src/services/tone-profile.js";

describe("tone-profile prompt builder", () => {
  it("returns empty string for null", () => {
    expect(buildTonePrompt(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(buildTonePrompt(undefined)).toBe("");
  });

  it("returns empty string for empty object", () => {
    expect(buildTonePrompt({})).toBe("");
  });

  it("builds prompt from known keys", () => {
    const result = buildTonePrompt({
      voice: "权威专业",
      audience: "25-35岁职场人",
      style: "深度分析",
    });
    expect(result).toContain("## 账号风格要求（请严格遵循）");
    expect(result).toContain("内容风格/语调：权威专业");
    expect(result).toContain("目标受众：25-35岁职场人");
    expect(result).toContain("写作风格：深度分析");
  });

  it("skips null/empty values", () => {
    const result = buildTonePrompt({
      voice: "温和",
      audience: "",
      style: null as any,
      tone: undefined as any,
    });
    expect(result).toContain("内容风格/语调：温和");
    expect(result).not.toContain("目标受众");
    expect(result).not.toContain("写作风格");
    expect(result).not.toContain("语气");
    expect(result.split("\n").filter(Boolean).length).toBe(2); // header + 1 line (trailing \n adds empty)
  });

  it("flattens array values with Chinese comma", () => {
    const result = buildTonePrompt({
      avoidTopics: ["政治", "宗教", "色情"],
    });
    expect(result).toContain("需避免的话题：政治、宗教、色情");
  });

  it("flattens nested object values", () => {
    const result = buildTonePrompt({
      brandVoice: { positioning: "行业专家", tone: "权威但不傲慢" },
    });
    expect(result).toContain("品牌声音定位：positioning: 行业专家，tone: 权威但不傲慢");
  });

  it("uses raw key name for unknown keys", () => {
    const result = buildTonePrompt({
      customField: "自定义值",
    });
    expect(result).toContain("customField：自定义值");
  });

  it("handles all standard keys", () => {
    const result = buildTonePrompt({
      voice: "励志向上",
      audience: "大学生",
      style: "口语化短句",
      tone: "轻松活泼",
      wordCount: "500-800字",
      contentType: "短视频口播",
      avoidTopics: "负面新闻",
      brandVoice: "学长人设",
      hookStyle: "反问式开头",
      format: "分点列举+总结",
      personality: "温暖学长",
      values: "真实、不装",
      niche: "大学生求职",
      competitorDifferentiator: "不讲空话，直接给方法",
    });
    expect(result).toContain("内容风格/语调：励志向上");
    expect(result).toContain("目标受众：大学生");
    expect(result).toContain("人设/人格：温暖学长");
    expect(result).toContain("垂类/细分领域：大学生求职");
  });

  it("returns empty for object with only empty values", () => {
    const result = buildTonePrompt({
      voice: "",
      audience: "",
      style: null as any,
    });
    expect(result).toBe("");
  });
});
