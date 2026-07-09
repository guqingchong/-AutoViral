import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---- Mocks (hoisted) ----

vi.mock("node:child_process", () => {
  const EE = require("node:events");
  return {
    spawn: vi.fn(() => {
      const proc = new EE.EventEmitter() as any;
      proc.stdout = new EE.EventEmitter() as any;
      proc.stderr = new EE.EventEmitter() as any;
      proc.kill = vi.fn();
      return proc;
    }),
  };
});

vi.mock("../../src/ws-bridge.js", () => ({
  resolveClaudeCommand: vi.fn(() => "claude"),
}));

import { spawn } from "node:child_process";
import {
  generateArticleFromTopic,
  generateScriptFromArticle,
  type GeneratedArticle,
} from "../../src/services/content-generator.js";

// ---- Helpers ----

/**
 * Make spawn emit a successful JSON result.
 */
function setupSpawnResult(jsonResult: string) {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.kill = vi.fn();
    setTimeout(() => {
      proc.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ result: jsonResult }))
      );
      proc.emit("exit", 0);
    }, 10);
    return proc;
  });
}

/**
 * Make spawn emit error instead of exit.
 */
function setupSpawnError() {
  vi.mocked(spawn).mockImplementation(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.kill = vi.fn();
    setTimeout(() => proc.emit("error", new Error("spawn failed")), 10);
    return proc;
  });
}

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

    it("returns generated article from Claude JSON response", async () => {
      setupSpawnResult(
        JSON.stringify({
          title: "AI 绘画：小白也能成为艺术家",
          content: "这是一篇关于 AI 绘画的完整文章。\n\n第一段...\n\n第二段...",
        })
      );

      const article = await generateArticleFromTopic(topic, "douyin");
      expect(article.title).toBe("AI 绘画：小白也能成为艺术家");
      expect(article.content).toContain("AI 绘画");
      expect(article.platform).toBeUndefined(); // platform is only in the returned interface
    });

    it("handles markdown-wrapped JSON in Claude output", async () => {
      setupSpawnResult(
        "```json\n{\n  \"title\": \"标题\",\n  \"content\": \"正文内容\"\n}\n```"
      );

      const article = await generateArticleFromTopic(topic, "xiaohongshu");
      expect(article.title).toBe("标题");
      expect(article.content).toBe("正文内容");
    });

    it("rejects when spawn errors", async () => {
      setupSpawnError();
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

    it("returns generated script from Claude JSON response", async () => {
      setupSpawnResult(
        JSON.stringify({
          scenes: [
            { timestamp: "0:00-0:15", narration: "开场白", visual: "主持人面对镜头" },
            { timestamp: "0:15-0:45", narration: "正文部分", visual: "AI 绘画过程展示" },
          ],
          duration: 45,
        })
      );

      const script = await generateScriptFromArticle(article, 45);
      expect(script.duration).toBe(45);
      expect(script.scenes).toHaveLength(2);
      expect(script.scenes[0].narration).toBe("开场白");
    });

    it("rejects when spawn errors", async () => {
      setupSpawnError();
      await expect(generateScriptFromArticle(article, 180)).rejects.toThrow();
    });
  });
});
