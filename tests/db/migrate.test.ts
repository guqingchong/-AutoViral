import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

describe("migrate", () => {
  beforeEach(() => resetInMemoryDb());
  afterEach(() => closeDb());

  it("creates expected tables", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[];
    expect(tables).toContain("works");
    expect(tables).toContain("pipeline_steps");
    expect(tables).toContain("topics");
  });

  it("creates phase 2 tables", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[];
    expect(tables).toContain("avatars");
    expect(tables).toContain("digital_human_jobs");
    expect(tables).toContain("asset_library");
  });

  it("creates templates and render_jobs tables", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[];
    expect(tables).toContain("templates");
    expect(tables).toContain("render_jobs");
  });

  it("records applied migrations", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const rows = db.prepare("SELECT version FROM migrations").all() as { version: number }[];
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });

  it("creates v4 publish and compliance tables", () => {
    const db = resetInMemoryDb();
    migrate();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .pluck()
      .all() as string[];
    expect(tables).toContain("publish_accounts");
    expect(tables).toContain("publish_jobs");
    expect(tables).toContain("compliance_banned_words");
  });

  it("seeds default banned words", () => {
    const db = resetInMemoryDb();
    migrate();
    const count = db
      .prepare("SELECT COUNT(*) FROM compliance_banned_words WHERE platform = 'all'")
      .pluck()
      .get() as number;
    expect(count).toBeGreaterThan(0);
  });
});
