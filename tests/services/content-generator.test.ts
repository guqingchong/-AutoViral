import { vi, describe, it, expect, beforeEach } from "vitest";

// 2026-08-18 P3-T1:传输层已从 spawn Claude CLI 切换为 LLM 直连(runJsonPrompt→chatJson),
// 此处 mock 直连入口;JSON 提取/重试由 llm 层测试覆盖(tests/llm/*)。
vi.mock("../../src/services/llm-json.js", () => ({
  runJsonPrompt: vi.fn(),
}));

import { runJsonPrompt } from "../../src/services/llm-json.js";
import {
  generateArticleFromTopic,
  generateScriptFromArticle,
  type GeneratedArticle,
} from "../../src/services/content-generator.js";

describe("content-generator service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ----------
  // generateArticleFromTopic
  // ----------

  describe("generateArticleFromTopic", () => {
    const topic = {
      id: 1,
      title: "AI 绘画趋势",
      description: "AI 绘画的发展趋势",
      heat: 5,
      competition: "中",
      opportunity: "金矿",
      emotion_type: "焦虑",
      emotion_subtype: "被替代焦虑",
      tags: ["AI", "绘画"],
      content_angles: ["小白入门", "工具推荐"],
      example_hook: "你也能成为 AI 画家",
      category: "科技",
      status: "collected" as const,
      created_at: "2026-07-09T00:00:00Z",
    };

    it("returns generated article from LLM JSON response", async () => {
      vi.mocked(runJsonPrompt).mockResolvedValue({
        title: "AI 绘画：小白也能成为艺术家",
        content: "这是一篇关于 AI 绘画的完整文章。\n\n第一段...\n\n第二段...",
      });

      const article = await generateArticleFromTopic(topic, "douyin");
      expect(article.title).toBe("AI 绘画：小白也能成为艺术家");
      expect(article.content).toContain("AI 绘画");
      expect(article.platform).toBeUndefined(); // platform is only in the returned interface
    });

    it("propagates LLM transport/parse errors", async () => {
      vi.mocked(runJsonPrompt).mockRejectedValue(new Error("chatJson 无法从响应提取 JSON"));
      await expect(generateArticleFromTopic(topic, "douyin")).rejects.toThrow();
    });
  });

  // ----------
  // generateScriptFromArticle
  // ----------

  describe("generateScriptFromArticle", () => {
    const article: GeneratedArticle = {
      title: "测试文章",
      content: "这是文章正文内容。",
      platform: "douyin",
    };

    it("returns generated script from LLM JSON response", async () => {
      vi.mocked(runJsonPrompt).mockResolvedValue({
        scenes: [
          { timestamp: "0:00-0:15", narration: "开场白", visual: "主持人面对镜头" },
          { timestamp: "0:15-0:45", narration: "正文部分", visual: "AI 绘画过程展示" },
        ],
        duration: 45,
      });

      const script = await generateScriptFromArticle(article, 45);
      expect(script.duration).toBe(45);
      expect(script.scenes).toHaveLength(2);
      expect(script.scenes[0].narration).toBe("开场白");
    });

    it("rejects when LLM call fails", async () => {
      vi.mocked(runJsonPrompt).mockRejectedValue(new Error("LLM API 500"));
      await expect(generateScriptFromArticle(article, 180)).rejects.toThrow();
    });
  });
});
