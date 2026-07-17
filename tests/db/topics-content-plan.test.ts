import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createTopic, getTopic, updateTopic } from "../../src/db/topics-repo.js";

describe("topics content_plan field (PRD 4.1.5)", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("persists and retrieves structured content_plan", () => {
    const plan = {
      coreViewpoint: "车险涨价不是保险问题而是风险定价",
      targetAudience: "新能源车主",
      expectedStructure: "钩子-原因-影响-建议",
      referenceSources: ["https://example.com/a", "https://example.com/b"],
    };
    const t = createTopic({
      platform: "douyin",
      title: "新能源车险暴涨",
      tags: [],
      content_angles: [],
      content_plan: plan,
      status: "collected",
    });
    const fetched = getTopic(t.id);
    expect(fetched?.content_plan).toEqual(plan);
  });

  it("updates content_plan independently", () => {
    const t = createTopic({
      platform: "douyin",
      title: "T",
      tags: [],
      content_angles: [],
      status: "collected",
    });
    expect(t.content_plan).toBeUndefined();
    updateTopic(t.id, { content_plan: { coreViewpoint: "v" } });
    expect(getTopic(t.id)?.content_plan).toEqual({ coreViewpoint: "v" });
  });
});