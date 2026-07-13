import { describe, it, expect, beforeEach } from "vitest";
import { resetInMemoryDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as bannedWordsRepo from "../../src/db/banned-words-repo.js";
import { scanBannedWords } from "../../src/services/compliance-text.js";

describe("compliance-text", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  it("returns passed when no banned words", () => {
    const result = scanBannedWords({ text: "这是一段正常的文案", platform: "xiaohongshu" });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects seeded banned words", () => {
    const result = scanBannedWords({ text: "这里包含赌博诱导", platform: "xiaohongshu" });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("includes platform-specific words", () => {
    bannedWordsRepo.createBannedWord({ platform: "xiaohongshu", word: "引流", severity: "medium" });
    const result = scanBannedWords({ text: "引流到私域", platform: "xiaohongshu" });
    expect(result.violations.some(v => v.word === "引流")).toBe(true);
  });

  it("returns passed for empty text", () => {
    const result = scanBannedWords({ text: "", platform: "xiaohongshu" });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("extracts context around the matched word", () => {
    const result = scanBannedWords({ text: "前缀文字赌博后缀文字", platform: "xiaohongshu" });
    expect(result.passed).toBe(false);
    const violation = result.violations.find(v => v.word === "赌博");
    expect(violation).toBeDefined();
    expect(violation!.context).toContain("赌博");
    expect(violation!.severity).toBe("high");
  });

  it("deduplicates when same word exists in 'all' and platform-specific", () => {
    bannedWordsRepo.createBannedWord({ platform: "xiaohongshu", word: "赌博", severity: "medium" });
    const result = scanBannedWords({ text: "包含赌博内容", platform: "xiaohongshu" });
    const gamblingViolations = result.violations.filter(v => v.word === "赌博");
    expect(gamblingViolations).toHaveLength(1);
  });

  it("detects multiple different banned words in one text", () => {
    const result = scanBannedWords({ text: "赌博和毒品都是违禁的", platform: "xiaohongshu" });
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
    const words = result.violations.map(v => v.word);
    expect(words).toContain("赌博");
    expect(words).toContain("毒品");
  });

  it("handles word at text boundaries without out-of-range errors", () => {
    const result = scanBannedWords({ text: "赌博", platform: "xiaohongshu" });
    expect(result.passed).toBe(false);
    const violation = result.violations.find(v => v.word === "赌博");
    expect(violation!.context).toBe("赌博");
  });
});
