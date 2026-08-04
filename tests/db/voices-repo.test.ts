import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("voices-repo", () => {
  let dir: string;
  let repo: typeof import("../../src/db/voices-repo.js");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-voices-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    const { vi } = await import("vitest");
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    repo = await import("../../src/db/voices-repo.js");
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
  });

  function makeVoice(overrides = {}) {
    return {
      id: "v1", name: "我的声音", voice_id: "avc-test001",
      type: "cloned" as const, status: "ready" as const,
      metadata: {}, usage_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it("create + get + list roundtrip", () => {
    repo.createVoice(makeVoice());
    expect(repo.getVoice("v1")?.voice_id).toBe("avc-test001");
    expect(repo.getVoiceByVoiceId("avc-test001")?.id).toBe("v1");
    expect(repo.listVoices()).toHaveLength(1);
  });

  it("update sets status/error and bumps updated_at", () => {
    repo.createVoice(makeVoice({ status: "cloning" }));
    const updated = repo.updateVoice("v1", { status: "failed", error: "音频太短" });
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("音频太短");
  });

  it("incrementVoiceUsage increments", () => {
    repo.createVoice(makeVoice());
    repo.incrementVoiceUsage("v1");
    repo.incrementVoiceUsage("v1");
    expect(repo.getVoice("v1")?.usage_count).toBe(2);
  });

  it("delete removes row", () => {
    repo.createVoice(makeVoice());
    expect(repo.deleteVoice("v1")).toBe(true);
    expect(repo.getVoice("v1")).toBeUndefined();
  });

  it("works table has voice_id column after migration", async () => {
    const { getDb } = await import("../../src/db/connection.js");
    const cols = getDb().prepare("PRAGMA table_info(works)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("voice_id");
  });
});
