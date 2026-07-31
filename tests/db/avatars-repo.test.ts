import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAvatar, getAvatar, listAvatars, updateAvatar, deleteAvatar } from "../../src/db/avatars-repo.js";

function makeAvatar(overrides: Partial<import("../../src/db/types.js").DbAvatar> = {}): import("../../src/db/types.js").DbAvatar {
  return {
    id: "avatar_test_001",
    name: "Test Avatar",
    status: "ready",
    source: "heygem",
    provider_avatar_id: "cj_123",
    config: { pitch: 1 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("avatars-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and retrieves an avatar", () => {
    createAvatar(makeAvatar());
    const found = getAvatar("avatar_test_001");
    expect(found?.name).toBe("Test Avatar");
    expect(found?.config).toEqual({ pitch: 1 });
  });

  it("lists avatars by updated_at desc", () => {
    createAvatar(makeAvatar({ id: "a1", name: "A", updated_at: "2026-01-01T00:00:00Z" }));
    createAvatar(makeAvatar({ id: "a2", name: "B", updated_at: "2026-01-02T00:00:00Z" }));
    expect(listAvatars()[0].id).toBe("a2");
  });

  it("updates and deletes an avatar", () => {
    createAvatar(makeAvatar());
    updateAvatar("avatar_test_001", { status: "failed" });
    expect(getAvatar("avatar_test_001")?.status).toBe("failed");
    expect(deleteAvatar("avatar_test_001")).toBe(true);
    expect(getAvatar("avatar_test_001")).toBeUndefined();
  });
});
