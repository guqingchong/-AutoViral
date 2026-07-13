/**
 * Tests for src/db/backup.ts — export, import, and restore operations.
 */
import { describe, it, expect } from "vitest";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { exportBackup, importBackup, getBackupPaths } from "../../src/db/backup.js";
import { closeDb } from "../../src/db/connection.js";

/**
 * Create a unique test data directory with minimal file structure.
 * Each test gets its own directory to avoid cross-test file-lock issues.
 */
async function setupDataDir(): Promise<string> {
  const dir = join(tmpdir(), `av-bkup-${randomUUID()}`);
  process.env.AUTOVIRAL_DATA_DIR = dir;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), "platforms: []\n", "utf-8");
  await mkdir(join(dir, "skills"), { recursive: true });
  await writeFile(join(dir, "skills", "test-skill.md"), "# Test", "utf-8");
  return dir;
}

async function teardownDataDir(dir: string): Promise<void> {
  delete process.env.AUTOVIRAL_DATA_DIR;
  try { closeDb(); } catch { /* already closed */ }
  try { await rm(dir, { recursive: true, force: true }); } catch { /* Windows file-lock, non-fatal */ }
}

describe("getBackupPaths", () => {
  it("returns paths under the config directory", async () => {
    const dir = await setupDataDir();
    try {
      const paths = await getBackupPaths();
      expect(paths.db).toContain(dir);
      expect(paths.config).toContain(dir);
      expect(paths.skills).toContain(dir);
      expect(paths.assets).toContain(dir);
      expect(paths.works).toContain(dir);
    } finally {
      await teardownDataDir(dir);
    }
  });
});

describe("exportBackup", () => {
  it("creates a zip file at the destination path", async () => {
    const dir = await setupDataDir();
    try {
      const dest = join(dir, "backup.zip");
      const { getDb } = await import("../../src/db/connection.js");
      getDb();

      await exportBackup(dest);
      const st = await stat(dest);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);
    } finally {
      await teardownDataDir(dir);
    }
  });

  it("zip contains config file when it exists", async () => {
    const dir = await setupDataDir();
    try {
      const dest = join(dir, "backup2.zip");
      const { getDb } = await import("../../src/db/connection.js");
      getDb();

      await exportBackup(dest);

      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(dest);
      const entries = zip.getEntries().map(e => e.entryName);
      expect(entries.some(e => e.startsWith("config/"))).toBe(true);
    } finally {
      await teardownDataDir(dir);
    }
  });

  it("zip contains skills folder when it exists", async () => {
    const dir = await setupDataDir();
    try {
      const dest = join(dir, "backup3.zip");
      const { getDb } = await import("../../src/db/connection.js");
      getDb();

      await exportBackup(dest);

      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip(dest);
      const entries = zip.getEntries().map(e => e.entryName);
      expect(entries.some(e => e.startsWith("skills/"))).toBe(true);
    } finally {
      await teardownDataDir(dir);
    }
  });
});

describe("importBackup", () => {
  it("restores config from a backup zip", async () => {
    const dir = await setupDataDir();
    try {
      const dest = join(dir, "backup-import.zip");
      const { getDb } = await import("../../src/db/connection.js");
      getDb();
      await exportBackup(dest);

      // Remove config to simulate restore
      await rm(join(dir, "config.yaml"), { force: true });

      const restored = await importBackup(dest, { overwrite: true });
      expect(restored).toContain("config/config.yaml");

      const st = await stat(join(dir, "config.yaml"));
      expect(st.isFile()).toBe(true);
    } finally {
      await teardownDataDir(dir);
    }
  });

  it("throws on non-existent backup file", async () => {
    const dir = await setupDataDir();
    try {
      await expect(
        importBackup(join(dir, "nonexistent.zip"))
      ).rejects.toThrow();
    } finally {
      await teardownDataDir(dir);
    }
  });

  it("restored list includes skills and config from the zip", async () => {
    const dir = await setupDataDir();
    try {
      const dest = join(dir, "backup-partial.zip");
      const { getDb } = await import("../../src/db/connection.js");
      getDb();
      await exportBackup(dest);

      const restored = await importBackup(dest, { overwrite: true });
      expect(restored.some(r => r.startsWith("skills"))).toBe(true);
      expect(restored.some(r => r.startsWith("config"))).toBe(true);
    } finally {
      await teardownDataDir(dir);
    }
  });
});
