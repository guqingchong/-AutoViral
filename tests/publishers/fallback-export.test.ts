import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateFallbackPackage } from "../../src/services/publishers/fallback-export.js";
import type { PublishInput } from "../../src/services/publishers/types.js";

describe("generateFallbackPackage", () => {
  const baseDir = join(tmpdir(), "autoviral-fallback-test");

  beforeEach(async () => {
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("creates tar.gz with video, metadata and guide", async () => {
    const videoPath = join(baseDir, "video.mp4");
    await writeFile(videoPath, "fake-video-data");
    const input: PublishInput = {
      workId: "w1",
      videoPath,
      title: "T",
      options: { description: "D", tags: ["a"] },
    };
    const zipPath = await generateFallbackPackage("xiaohongshu", input, join(baseDir, "out"));
    expect(existsSync(zipPath)).toBe(true);
    expect(zipPath.endsWith(".zip")).toBe(true);
  });
});
