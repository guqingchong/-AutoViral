import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

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
    execFile: vi.fn(() => {
      // promisify expects a callback-style function; the callback is appended by promisify
      // This default returns empty data — each test overrides via mockImplementation
    }),
  };
});

vi.mock("../../src/ws-bridge.js", () => ({
  resolveClaudeCommand: vi.fn(() => "claude"),
}));

import { spawn, execFile } from "node:child_process";
import { fetchTrendData, collectTrends } from "../../src/services/trend-research.js";
import { listTopics } from "../../src/db/topics-repo.js";

// ---- Helpers ----

/**
 * Make the spawn mock emit a given JSON result for Claude CLI.
 */
function setupSpawnResult(topics: any[] = []) {
  const payload = JSON.stringify({ topics });
  vi.mocked(spawn).mockImplementation(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter() as any;
    proc.stderr = new EventEmitter() as any;
    proc.kill = vi.fn();
    setTimeout(() => {
      proc.stdout.emit("data", Buffer.from(JSON.stringify({ result: payload })));
      proc.emit("exit", 0);
    }, 10);
    return proc;
  });
}

/**
 * Make the execFile mock return a given stdout string.
 */
function setupExecFileResult(stdout: string) {
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === "function");
    if (cb) {
      setTimeout(() => cb(null, { stdout, stderr: "" }), 5);
    }
  });
}

/**
 * Make the execFile mock throw (simulating python script failure).
 */
function setupExecFileError() {
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = args.find((a: any) => typeof a === "function");
    if (cb) {
      setTimeout(() => cb(new Error("Script failed"), { stdout: "", stderr: "" }), 5);
    }
  });
}

describe("trend-research service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.clearAllMocks();
  });

  afterEach(() => closeDb());

  // ----------
  // fetchTrendData
  // ----------

  describe("fetchTrendData", () => {
    it("returns stdout for douyin platform", async () => {
      setupExecFileResult('{"hot_search": ["item1", "item2"]}');
      const result = await fetchTrendData("douyin");
      expect(result).toBe('{"hot_search": ["item1", "item2"]}');
      expect(vi.mocked(execFile)).toHaveBeenCalled();
    });

    it("returns stdout for xiaohongshu platform", async () => {
      setupExecFileResult('{"trends": ["trend1"]}');
      const result = await fetchTrendData("xiaohongshu");
      expect(result).toBe('{"trends": ["trend1"]}');
    });

    it("returns empty string on execFile error", async () => {
      setupExecFileError();
      const result = await fetchTrendData("douyin");
      expect(result).toBe("");
    });
  });

  // ----------
  // collectTrends
  // ----------

  describe("collectTrends", () => {
    it("collects trends and stores snapshot and topics", async () => {
      setupExecFileResult('{"items": [{"title": "热门话题"}]}');
      setupSpawnResult([
        {
          title: "AI 绘画趋势",
          heat: 5,
          competition: "中",
          opportunity: "金矿",
          emotionType: "焦虑",
          emotionSubtype: "被替代焦虑",
          description: "AI 绘画在社交媒体上持续火爆",
          tags: ["AI", "绘画", "科技"],
          contentAngles: ["小白也能上手", "3 天学会"],
          exampleHook: "你绝对想不到 AI 现在能画成这样",
          category: "科技",
        },
      ]);

      const results = await collectTrends(["douyin"], ["科技"]);

      expect(results).toHaveLength(1);
      expect(results[0].platform).toBe("douyin");
      expect(results[0].topics).toHaveLength(1);
      expect(results[0].topics[0].title).toBe("AI 绘画趋势");
      expect(results[0].topics[0].status).toBe("collected");

      // Verify topics are persisted in DB
      const dbTopics = listTopics("douyin");
      expect(dbTopics).toHaveLength(1);
      expect(dbTopics[0].title).toBe("AI 绘画趋势");
    });

    it("handles non-JSON raw data gracefully (no crash)", async () => {
      // Fetch returns non-JSON string (e.g. Python traceback)
      setupExecFileResult("Traceback (most recent call last):\n  File \"script.py\", line 1\nSyntaxError: ...");
      setupSpawnResult([]);

      const results = await collectTrends(["xiaohongshu"], []);
      expect(results).toHaveLength(1);
      // Even with bad raw data, snapshot should be created and topics empty
      expect(results[0].topics).toEqual([]);
    });

    it("handles empty fetch data gracefully", async () => {
      setupExecFileResult("");
      setupSpawnResult([]);

      const results = await collectTrends(["douyin"], []);
      expect(results).toHaveLength(1);
      expect(results[0].topics).toEqual([]);
    });

    it("handles spawn error in analyzeTrendsWithAgent", async () => {
      setupExecFileResult('{"items": []}');
      // Make spawn emit error instead of exit
      vi.mocked(spawn).mockImplementation(() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter() as any;
        proc.stderr = new EventEmitter() as any;
        proc.kill = vi.fn();
        setTimeout(() => proc.emit("error", new Error("spawn failed")), 5);
        return proc;
      });

      const results = await collectTrends(["douyin"], []);
      expect(results).toHaveLength(1);
      expect(results[0].topics).toEqual([]);
    });

    it("handles spawn with empty output gracefully", async () => {
      setupExecFileResult('{"items": []}');
      // spawn emits exit with empty stdout -> JSON.parse fails -> resolves []
      vi.mocked(spawn).mockImplementation(() => {
        const proc = new EventEmitter() as any;
        proc.stdout = new EventEmitter() as any;
        proc.stderr = new EventEmitter() as any;
        proc.kill = vi.fn();
        setTimeout(() => {
          proc.stdout.emit("data", Buffer.from(""));
          proc.emit("exit", 0);
        }, 10);
        return proc;
      });

      const results = await collectTrends(["douyin"], []);
      expect(results).toHaveLength(1);
      expect(results[0].topics).toEqual([]);
    });
  });
});
