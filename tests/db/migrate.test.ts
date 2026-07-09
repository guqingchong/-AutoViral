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

  it("records applied migration", () => {
    migrate();
    const db = resetInMemoryDb();
    migrate();
    const rows = db.prepare("SELECT version FROM migrations").all() as { version: number }[];
    expect(rows.length).toBeGreaterThan(0);
  });
});
