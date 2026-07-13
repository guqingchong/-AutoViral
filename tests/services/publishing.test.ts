import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as recordsRepo from "../../src/db/publish-records-repo.js";
import { getPublishingStatus, toPublishRecord } from "../../src/services/publishing.js";

describe("publishing service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("toPublishRecord maps DB row to PublishRecord", () => {
    const now = new Date().toISOString();
    const created = recordsRepo.createPublishRecord({
      work_id: "w1",
      platform: "douyin",
      status: "published",
    });
    const row = recordsRepo.getPublishRecord(created.id);
    const record = toPublishRecord(row!);
    expect(record.workId).toBe("w1");
    expect(record.platform).toBe("douyin");
    expect(record.status).toBe("published");
  });

  it("getPublishingStatus returns PublishRecord[]", async () => {
    recordsRepo.createPublishRecord({ work_id: "w1", platform: "fake", status: "published" });
    const status = await getPublishingStatus("w1");
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status[0].status).toBe("published");
  });
});
