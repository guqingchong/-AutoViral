import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as repo from "../../src/db/banned-words-repo.js";

describe("banned-words-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates a banned word and returns full object", () => {
    const word = repo.createBannedWord({ platform: "douyin", word: "测试违禁词", severity: "high" });
    expect(word.id).toBeGreaterThan(0);
    expect(word.word).toBe("测试违禁词");
    expect(word.severity).toBe("high");
    expect(word.platform).toBe("douyin");
    expect(word.created_at).toBeTruthy();
  });

  it("lists all banned words when no platform filter", () => {
    // Default seeds from migration
    const words = repo.listBannedWords();
    expect(words.length).toBeGreaterThan(0);
    expect(words.some(w => w.word === "色情")).toBe(true);
  });

  it("filters banned words by platform including 'all' matches", () => {
    repo.createBannedWord({ platform: "xiaohongshu", word: "专测词", severity: "medium" });
    const filtered = repo.listBannedWords("xiaohongshu");
    expect(filtered.some(w => w.word === "专测词")).toBe(true);
    // 'all' platform words should also appear
    expect(filtered.some(w => w.word === "色情")).toBe(true);
  });

  it("deletes a banned word", () => {
    const word = repo.createBannedWord({ platform: "douyin", word: "临时违禁词", severity: "low" });
    expect(repo.deleteBannedWord(word.id)).toBe(true);
    const remaining = repo.listBannedWords().filter(w => w.id === word.id);
    expect(remaining.length).toBe(0);
  });

  it("returns false when deleting nonexistent word", () => {
    expect(repo.deleteBannedWord(99999)).toBe(false);
  });

  it("filters banned words by severity", () => {
    repo.createBannedWord({ platform: "douyin", word: "low_risk", severity: "low" });
    const highOnly = repo.listBannedWords(undefined, "high");
    expect(highOnly.every(w => w.severity === "high")).toBe(true);
    // "low_risk" should not appear in high-only results
    expect(highOnly.some(w => w.word === "low_risk")).toBe(false);
  });

  it("lists words ordered by id desc", () => {
    const w1 = repo.createBannedWord({ platform: "douyin", word: "word_a", severity: "high" });
    const w2 = repo.createBannedWord({ platform: "douyin", word: "word_b", severity: "high" });
    const all = repo.listBannedWords();
    const idx1 = all.findIndex(w => w.id === w1.id);
    const idx2 = all.findIndex(w => w.id === w2.id);
    // w2 (newer) should come before w1 (older) in desc order
    expect(idx2).toBeLessThan(idx1);
  });
});
