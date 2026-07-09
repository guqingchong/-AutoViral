import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, resetInMemoryDb } from "../../src/db/connection.js";

describe("db connection", () => {
  afterEach(() => closeDb());

  it("opens an in-memory database", () => {
    const db = resetInMemoryDb();
    const result = db.prepare("SELECT 1 + 1 AS n").get() as { n: number };
    expect(result.n).toBe(2);
  });
});
