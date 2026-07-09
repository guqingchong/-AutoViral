import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork, getWork, listWorks, updateWork, deleteWork, getWorkSteps, workExists, updateStep } from "../../src/db/works-repo.js";
import type { DbWork, DbPipelineStep } from "../../src/db/types.js";

function makeWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: "w_20260708_1200_abc",
    title: "Test Work",
    type: "short-video",
    status: "draft",
    platforms: ["douyin"],
    evaluation_mode: false,
    tags: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("works-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a work with steps", () => {
    const work = makeWork();
    const steps: DbPipelineStep[] = [
      { work_id: work.id, step_key: "research", name: "话题调研", status: "pending", sort_order: 0 },
    ];
    createWork(work, steps);
    const found = getWork(work.id);
    expect(found?.title).toBe("Test Work");
    expect(getWorkSteps(work.id).length).toBe(1);
  });

  it("lists works by updated_at desc", () => {
    createWork(makeWork({ id: "w1", title: "A", updated_at: "2026-01-01T00:00:00Z" }), []);
    createWork(makeWork({ id: "w2", title: "B", updated_at: "2026-01-02T00:00:00Z" }), []);
    const list = listWorks();
    expect(list[0].id).toBe("w2");
  });

  it("updates a work", () => {
    createWork(makeWork(), []);
    const updated = updateWork("w_20260708_1200_abc", { title: "Updated" });
    expect(updated?.title).toBe("Updated");
  });

  it("deletes a work and cascades steps", () => {
    const work = makeWork();
    createWork(work, [{ work_id: work.id, step_key: "research", name: "调研", status: "pending", sort_order: 0 }]);
    expect(deleteWork(work.id)).toBe(true);
    expect(getWork(work.id)).toBeUndefined();
    expect(getWorkSteps(work.id).length).toBe(0);
  });

  it("persists topic metadata fields", () => {
    createWork(
      makeWork({
        topic_category: "科技",
        emotion_type: "焦虑",
        hook_type: "经济损失",
        template_id: "tpl_001",
        tags: ["新能源", "车险"],
      }),
      []
    );
    const found = getWork("w_20260708_1200_abc");
    expect(found?.topic_category).toBe("科技");
    expect(found?.emotion_type).toBe("焦虑");
    expect(found?.hook_type).toBe("经济损失");
    expect(found?.template_id).toBe("tpl_001");
    expect(found?.tags).toEqual(["新能源", "车险"]);
  });

  it("workExists returns true for existing work", () => {
    createWork(makeWork(), []);
    expect(workExists("w_20260708_1200_abc")).toBe(true);
  });

  it("workExists returns false for non-existent work", () => {
    expect(workExists("nonexistent")).toBe(false);
  });

  it("updateStep updates a step status", () => {
    const work = makeWork();
    createWork(work, [
      { work_id: work.id, step_key: "research", name: "话题调研", status: "pending", sort_order: 0 },
      { work_id: work.id, step_key: "plan", name: "内容策划", status: "pending", sort_order: 1 },
    ]);
    updateStep(work.id, "research", { status: "active" });
    const steps = getWorkSteps(work.id);
    expect(steps.find((s) => s.step_key === "research")?.status).toBe("active");
    expect(steps.find((s) => s.step_key === "plan")?.status).toBe("pending");
  });
});
