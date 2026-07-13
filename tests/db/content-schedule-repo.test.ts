import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import {
  createSchedule,
  getSchedule,
  listByDateRange,
  listByMonth,
  getMonthCounts,
  updateSchedule,
  deleteSchedule,
  listByWork,
  listByAccount,
} from "../../src/db/content-schedule-repo.js";
import type { DbContentSchedule } from "../../src/db/types.js";

function makeEntry(overrides: Partial<DbContentSchedule> = {}): DbContentSchedule {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: "Test Schedule Entry",
    description: "",
    scheduled_date: "2026-08-15",
    scheduled_time: "09:00",
    platform: "douyin",
    content_type: "short-video",
    status: "planned",
    color: "#FE2C55",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("content-schedule repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => {
    closeDb();
  });

  it("creates and retrieves a schedule entry", () => {
    const entry = makeEntry();
    const created = createSchedule(entry);
    expect(created).toEqual(entry);

    const found = getSchedule(entry.id);
    expect(found).toBeTruthy();
    expect(found!.title).toBe("Test Schedule Entry");
    expect(found!.scheduled_date).toBe("2026-08-15");
    expect(found!.scheduled_time).toBe("09:00");
  });

  it("returns undefined for missing entry", () => {
    expect(getSchedule("nonexistent")).toBeUndefined();
  });

  it("lists entries by date range", () => {
    createSchedule(makeEntry({ id: "s1", scheduled_date: "2026-08-14" }));
    createSchedule(makeEntry({ id: "s2", scheduled_date: "2026-08-15" }));
    createSchedule(makeEntry({ id: "s3", scheduled_date: "2026-08-16" }));

    const range = listByDateRange("2026-08-14", "2026-08-15");
    expect(range).toHaveLength(2);
    expect(range.map((e) => e.id)).toEqual(["s1", "s2"]);
  });

  it("lists entries by month", () => {
    createSchedule(makeEntry({ id: "a1", scheduled_date: "2026-08-01" }));
    createSchedule(makeEntry({ id: "a2", scheduled_date: "2026-08-31" }));
    createSchedule(makeEntry({ id: "a3", scheduled_date: "2026-09-01" }));

    const aug = listByMonth("2026-08");
    expect(aug).toHaveLength(2);
    expect(aug.map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("returns month counts grouped by day", () => {
    createSchedule(makeEntry({ id: "c1", scheduled_date: "2026-08-01" }));
    createSchedule(makeEntry({ id: "c2", scheduled_date: "2026-08-01" }));
    createSchedule(makeEntry({ id: "c3", scheduled_date: "2026-08-15" }));

    const counts = getMonthCounts("2026-08");
    expect(counts["01"]).toBe(2);
    expect(counts["15"]).toBe(1);
    expect(counts["02"]).toBeUndefined();
  });

  it("returns empty objects for month with no entries", () => {
    expect(getMonthCounts("2025-01")).toEqual({});
  });

  it("updates an entry", () => {
    const entry = makeEntry({ id: "upd1" });
    createSchedule(entry);

    const updated = updateSchedule("upd1", { title: "Updated Title", status: "done" });
    expect(updated).toBeTruthy();
    expect(updated!.title).toBe("Updated Title");
    expect(updated!.status).toBe("done");
    // unchanged fields preserved
    expect(updated!.scheduled_date).toBe("2026-08-15");
  });

  it("returns undefined when updating nonexistent entry", () => {
    expect(updateSchedule("nope", { title: "X" })).toBeUndefined();
  });

  it("deletes an entry", () => {
    createSchedule(makeEntry({ id: "del1" }));
    expect(deleteSchedule("del1")).toBe(true);
    expect(getSchedule("del1")).toBeUndefined();
  });

  it("returns false when deleting nonexistent entry", () => {
    expect(deleteSchedule("nope")).toBe(false);
  });

  it("lists entries by work_id", () => {
    createSchedule(makeEntry({ id: "w1", work_id: "work-a" }));
    createSchedule(makeEntry({ id: "w2", work_id: "work-a" }));
    createSchedule(makeEntry({ id: "w3", work_id: "work-b" }));

    expect(listByWork("work-a")).toHaveLength(2);
    expect(listByWork("work-b")).toHaveLength(1);
    expect(listByWork("work-c")).toEqual([]);
  });

  it("lists entries by account_id", () => {
    createSchedule(makeEntry({ id: "a1", account_id: "acct-1" }));
    createSchedule(makeEntry({ id: "a2", account_id: "acct-2" }));

    expect(listByAccount("acct-1")).toHaveLength(1);
    expect(listByAccount("acct-3")).toEqual([]);
  });
});
