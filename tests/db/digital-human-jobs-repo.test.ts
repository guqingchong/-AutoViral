import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAvatar } from "../../src/db/avatars-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import type { DbWork } from "../../src/db/types.js";
import { createJob, getJob, listJobs, updateJob, countActiveJobs, countActiveJobsByAvatar, deleteJob } from "../../src/db/digital-human-jobs-repo.js";

function makeWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: "w_test",
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

describe("digital-human-jobs-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and retrieves a job", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "job1", avatar_id: "av1", audio_path: "/audio.mp3", provider: "heygem", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(getJob("job1")?.avatar_id).toBe("av1");
  });

  it("filters jobs by work_id", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createWork(makeWork({ id: "w1" }), []);
    createWork(makeWork({ id: "w2" }), []);
    createJob({ id: "j1", work_id: "w1", avatar_id: "av1", audio_path: "/a.mp3", provider: "heygem", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j2", work_id: "w2", avatar_id: "av1", audio_path: "/b.mp3", provider: "heygem", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(listJobs("w1").length).toBe(1);
    expect(listJobs("w1")[0].id).toBe("j1");
  });

  it("updates job status", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j1", avatar_id: "av1", audio_path: "/a.mp3", provider: "heygem", status: "pending", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    updateJob("j1", { status: "running", progress: 50 });
    expect(getJob("j1")?.progress).toBe(50);
  });

  it("countActiveJobs counts pending/queued/running only", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j1", avatar_id: "av1", audio_path: "/a.mp3", provider: "heygem", status: "running", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j2", avatar_id: "av1", audio_path: "/b.mp3", provider: "heygem", status: "running", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j3", avatar_id: "av1", audio_path: "/c.mp3", provider: "heygem", status: "done", progress: 100, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(countActiveJobs()).toBe(2);
  });

  it("countActiveJobsByAvatar counts only that avatar's pending/queued/running jobs", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createAvatar({ id: "av2", name: "B", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j1", avatar_id: "av1", audio_path: "/a.mp3", provider: "heygem", status: "running", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j2", avatar_id: "av1", audio_path: "/b.mp3", provider: "heygem", status: "done", progress: 100, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j3", avatar_id: "av2", audio_path: "/c.mp3", provider: "heygem", status: "running", progress: 0, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(countActiveJobsByAvatar("av1")).toBe(1);
    expect(countActiveJobsByAvatar("av2")).toBe(1);
    expect(countActiveJobsByAvatar("av_missing")).toBe(0);
  });

  it("deleteJob removes the record and returns true; false for missing id", () => {
    createAvatar({ id: "av1", name: "A", status: "ready", source: "heygem", config: {}, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    createJob({ id: "j1", avatar_id: "av1", audio_path: "/a.mp3", provider: "heygem", status: "done", progress: 100, estimated_cost: 0, actual_cost: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(deleteJob("j1")).toBe(true);
    expect(getJob("j1")).toBeUndefined();
    expect(deleteJob("j1")).toBe(false);
  });
});
