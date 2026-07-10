import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { randomUUID } from "node:crypto";
import * as repo from "../../src/db/publish-accounts-repo.js";

describe("publish-accounts-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("creates and retrieves an account", () => {
    const account = {
      id: randomUUID(),
      platform: "xiaohongshu",
      display_name: "小红书主号",
      credentials: { token: "abc" },
      status: "active" as const,
      is_default: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    repo.createAccount(account);
    const found = repo.getAccount(account.id);
    expect(found?.display_name).toBe("小红书主号");
    expect(found?.credentials).toEqual({ token: "abc" });
    expect(found?.is_default).toBe(true);
  });

  it("returns undefined for missing account", () => {
    expect(repo.getAccount("nonexistent")).toBeUndefined();
  });

  it("lists accounts ordered by updated_at desc", () => {
    repo.createAccount({
      id: randomUUID(), platform: "douyin", display_name: "A",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
    });
    repo.createAccount({
      id: randomUUID(), platform: "douyin", display_name: "B",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z",
    });
    const accounts = repo.listAccounts();
    expect(accounts[0].display_name).toBe("B");
    expect(accounts[1].display_name).toBe("A");
  });

  it("updates an account", () => {
    const id = randomUUID();
    repo.createAccount({
      id, platform: "douyin", display_name: "Original",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    const updated = repo.updateAccount(id, { display_name: "Updated", status: "disabled" });
    expect(updated?.display_name).toBe("Updated");
    expect(updated?.status).toBe("disabled");
    const found = repo.getAccount(id);
    expect(found?.display_name).toBe("Updated");
  });

  it("returns undefined when updating nonexistent account", () => {
    expect(repo.updateAccount("nonexistent", { display_name: "Nope" })).toBeUndefined();
  });

  it("deletes an account", () => {
    const id = randomUUID();
    repo.createAccount({
      id, platform: "douyin", display_name: "DeleteMe",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    expect(repo.deleteAccount(id)).toBe(true);
    expect(repo.getAccount(id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent account", () => {
    expect(repo.deleteAccount("nonexistent")).toBe(false);
  });

  it("setDefaultAccount clears other defaults and sets the target", () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    repo.createAccount({
      id: id1, platform: "douyin", display_name: "A",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    repo.createAccount({
      id: id2, platform: "douyin", display_name: "B",
      credentials: {}, status: "active", is_default: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    });
    repo.setDefaultAccount(id1);
    expect(repo.getAccount(id1)?.is_default).toBe(true);
    expect(repo.getAccount(id2)?.is_default).toBe(false);
    repo.setDefaultAccount(id2);
    expect(repo.getAccount(id1)?.is_default).toBe(false);
    expect(repo.getAccount(id2)?.is_default).toBe(true);
  });
});
