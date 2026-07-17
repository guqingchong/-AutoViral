import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import {
  recordDataSourceReference,
  listFixedDataSources,
  listDataSources,
  DATA_SOURCE_PROMOTION_THRESHOLD,
} from "../../src/db/data-sources-repo.js";

describe("data-sources-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("increments reference count and promotes after threshold", () => {
    const url = "https://example.com/source";
    for (let i = 0; i < DATA_SOURCE_PROMOTION_THRESHOLD - 1; i++) {
      const s = recordDataSourceReference({ url, platform: "douyin", title: "Src" });
      expect(s.fixed).toBe(false);
      expect(s.reference_count).toBe(i + 1);
    }
    const promoted = recordDataSourceReference({ url, platform: "douyin", title: "Src" });
    expect(promoted.reference_count).toBe(DATA_SOURCE_PROMOTION_THRESHOLD);
    expect(promoted.fixed).toBe(true);

    const fixed = listFixedDataSources();
    expect(fixed.length).toBe(1);
    expect(fixed[0].url).toBe(url);
  });

  it("tracks distinct urls separately", () => {
    recordDataSourceReference({ url: "https://a.com" });
    recordDataSourceReference({ url: "https://a.com" });
    recordDataSourceReference({ url: "https://b.com" });
    const all = listDataSources();
    expect(all.length).toBe(2);
    expect(all.find((s) => s.url === "https://a.com")?.reference_count).toBe(2);
    expect(all.find((s) => s.url === "https://b.com")?.reference_count).toBe(1);
  });

  it("does not list non-fixed sources as fixed", () => {
    recordDataSourceReference({ url: "https://once.com" });
    expect(listFixedDataSources().length).toBe(0);
  });
});