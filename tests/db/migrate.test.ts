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

  it("records applied migrations", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const rows = db.prepare("SELECT version FROM migrations").all() as { version: number }[];
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });
});
