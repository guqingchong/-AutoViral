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
});
