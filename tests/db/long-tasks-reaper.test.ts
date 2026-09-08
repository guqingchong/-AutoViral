import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { reapZombieTasks, getLongTask, hasRunningLongTask } from "../../src/services/long-tasks.js";

// B3(2026-09-08):zombie reaper——服务重启后残留 running 行必须置 failed
describe("reapZombieTasks(B3)", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  function insertTask(id: string, status: string) {
    const now = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO long_tasks (id, kind, work_id, status, input_json, created_at, updated_at) VALUES (?, 'ffmpeg', 'w1', ?, '{}', ?, ?)",
    ).run(id, status, now, now);
  }

  it("残留 running 行置 failed(进程已死)", () => {
    insertTask("lt_zom1", "running");
    insertTask("lt_zom2", "running");
    insertTask("lt_ok1", "done");
    const reaped = reapZombieTasks();
    expect(reaped).toBe(2);
    expect(getLongTask("lt_zom1")!.status).toBe("failed");
    expect(getLongTask("lt_zom1")!.error).toContain("zombie");
    expect(getLongTask("lt_zom2")!.status).toBe("failed");
    expect(getLongTask("lt_ok1")!.status).toBe("done"); // 已完成的不动
  });

  it("reap 后 hasRunningLongTask 不再被僵尸行卡住", async () => {
    insertTask("lt_zom3", "running");
    expect(await hasRunningLongTask("w1")).toBe(true);
    reapZombieTasks();
    expect(await hasRunningLongTask("w1")).toBe(false);
  });

  it("无残留时返回 0", () => {
    insertTask("lt_ok2", "failed");
    expect(reapZombieTasks()).toBe(0);
  });
});
