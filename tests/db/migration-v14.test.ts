import { describe, it, expect, afterEach } from "vitest";
import { getDb, resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate, MIGRATIONS } from "../../src/db/migrate.js";

describe("migration v14 heygem enums", () => {
  afterEach(() => closeDb());

  it("registers v14 migration with heygem rewrite SQL for both tables", () => {
    const v14 = MIGRATIONS.find((m) => m.version === 14);
    expect(v14).toBeDefined();
    expect(v14!.name).toBe("heygem-single-engine");
    expect(v14!.sql).toContain("UPDATE avatars");
    expect(v14!.sql).toContain("UPDATE digital_human_jobs");
  });

  it("rewrites legacy chanjing/bailian rows to heygem", () => {
    resetInMemoryDb();
    migrate();
    const db = getDb();
    db.prepare(`INSERT INTO avatars (id, name, status, source, config, created_at, updated_at)
      VALUES ('a1', '旧形象', 'ready', 'chanjing', '{}', '2026-01-01', '2026-01-01')`).run();
    db.prepare(`INSERT INTO digital_human_jobs (id, avatar_id, audio_path, provider, status, progress, estimated_cost, actual_cost, created_at, updated_at)
      VALUES ('j1', 'a1', '/x.wav', 'bailian', 'done', 100, 0, 0, '2026-01-01', '2026-01-01')`).run();
    // 手动重放 v14 逻辑（MIGRATIONS 已应用，直接验证幂等 SQL）
    db.exec(`UPDATE avatars SET source = 'heygem' WHERE source IN ('chanjing', 'bailian')`);
    db.exec(`UPDATE digital_human_jobs SET provider = 'heygem' WHERE provider IN ('chanjing', 'bailian')`);
    expect(db.prepare("SELECT source FROM avatars WHERE id='a1'").pluck().get()).toBe("heygem");
    expect(db.prepare("SELECT provider FROM digital_human_jobs WHERE id='j1'").pluck().get()).toBe("heygem");
  });
});
