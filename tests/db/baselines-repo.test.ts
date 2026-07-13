import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createBaseline, getLatestBaseline } from "../../src/db/baselines-repo.js";

describe("baselines-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("stores and retrieves latest baseline", () => {
    createBaseline({ metric_name: "avg_views", platform: "douyin", value_json: { value: 1500 }, sample_count: 10, computed_at: "2026-07-01T00:00:00Z" });
    createBaseline({ metric_name: "avg_views", platform: "douyin", value_json: { value: 2000 }, sample_count: 12, computed_at: "2026-07-08T00:00:00Z" });
    const latest = getLatestBaseline("avg_views", "douyin");
    expect(latest?.value_json.value).toBe(2000);
  });
});
