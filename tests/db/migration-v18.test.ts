import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

describe("migration v18: templates.kind", () => {
  beforeEach(() => resetInMemoryDb());
  afterEach(() => closeDb());

  it("adds kind column to templates with default 'video'", () => {
    const db = resetInMemoryDb();
    migrate();
    const cols = db.prepare("PRAGMA table_info(templates)").all() as Array<{ name: string; dflt_value: string; notnull: number }>;
    const kind = cols.find((c) => c.name === "kind");
    expect(kind).toBeDefined();
    expect(kind!.notnull).toBe(1);
    expect(kind!.dflt_value).toBe("'video'");
  });

  it("is idempotent (running migrate twice does not fail)", () => {
    const db = resetInMemoryDb();
    migrate();
    migrate();
    const versions = db.prepare("SELECT version FROM migrations").pluck().all() as number[];
    expect(versions.filter((v) => v === 18).length).toBe(1);
  });
});
