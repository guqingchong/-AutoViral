import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

describe("migration v19: works 素材三维与双产物", () => {
  beforeEach(() => resetInMemoryDb());
  afterEach(() => closeDb());

  it("adds asset_form / asset_source / asset_budget / dual_output columns to works", () => {
    const db = resetInMemoryDb();
    migrate();
    const cols = db.prepare("PRAGMA table_info(works)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("asset_form");
    expect(names).toContain("asset_source");
    expect(names).toContain("asset_budget");
    expect(names).toContain("dual_output");
    const dual = cols.find((c) => c.name === "dual_output")!;
    expect(dual.notnull).toBe(1);
    expect(dual.dflt_value).toBe("0");
  });

  it("existing rows default dual_output to 0 and asset_* to NULL", () => {
    const db = resetInMemoryDb();
    migrate();
    db.prepare("INSERT INTO works (id, title, type, status, created_at, updated_at) VALUES ('w1', 't', 'short-video', 'draft', '2026-01-01', '2026-01-01')").run();
    const row = db.prepare("SELECT asset_form, asset_source, asset_budget, dual_output FROM works WHERE id = 'w1'").get() as any;
    expect(row.asset_form).toBeNull();
    expect(row.asset_source).toBeNull();
    expect(row.asset_budget).toBeNull();
    expect(row.dual_output).toBe(0);
  });

  it("is idempotent (running migrate twice does not fail)", () => {
    const db = resetInMemoryDb();
    migrate();
    migrate();
    const versions = db.prepare("SELECT version FROM migrations").pluck().all() as number[];
    expect(versions.filter((v) => v === 19).length).toBe(1);
  });
});
