import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createAccount, getAccount, listAccounts, updateAccount, deleteAccount, getWorksByAccount } from "../../src/db/accounts-repo.js";
import { createWork } from "../../src/db/works-repo.js";
import type { DbAccount, DbWork } from "../../src/db/types.js";

function makeAccount(overrides: Partial<DbAccount> = {}): DbAccount {
  return {
    id: "acct_test_001",
    name: "主账号",
    platform: "douyin",
    tone_profile: { voice: "professional", keywords: ["tech"] },
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("accounts-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and retrieves an account", () => {
    createAccount(makeAccount());
    const found = getAccount("acct_test_001");
    expect(found?.name).toBe("主账号");
    expect(found?.platform).toBe("douyin");
    expect(found?.tone_profile).toEqual({ voice: "professional", keywords: ["tech"] });
    expect(found?.status).toBe("active");
  });

  it("returns undefined for missing account", () => {
    expect(getAccount("nonexistent")).toBeUndefined();
  });

  it("lists accounts ordered by updated_at desc", () => {
    createAccount(makeAccount({ id: "a1", name: "A", updated_at: "2026-01-01T00:00:00Z" }));
    createAccount(makeAccount({ id: "a2", name: "B", updated_at: "2026-01-02T00:00:00Z" }));
    const list = listAccounts();
    expect(list[0].id).toBe("a2");
    expect(list[1].id).toBe("a1");
  });

  it("lists empty array when no accounts", () => {
    expect(listAccounts()).toEqual([]);
  });

  it("updates an account", () => {
    createAccount(makeAccount());
    const updated = updateAccount("acct_test_001", { name: "新名称", status: "inactive" });
    expect(updated?.name).toBe("新名称");
    expect(updated?.status).toBe("inactive");
    const found = getAccount("acct_test_001");
    expect(found?.name).toBe("新名称");
  });

  it("returns undefined when updating nonexistent account", () => {
    expect(updateAccount("nonexistent", { name: "Nope" })).toBeUndefined();
  });

  it("deletes an account with no references", () => {
    createAccount(makeAccount());
    expect(deleteAccount("acct_test_001")).toBe(true);
    expect(getAccount("acct_test_001")).toBeUndefined();
  });

  it("returns false when deleting nonexistent account", () => {
    expect(deleteAccount("nonexistent")).toBe(false);
  });

  it("throws when deleting an account referenced by works", () => {
    createAccount(makeAccount());
    const now = new Date().toISOString();
    const work: DbWork = {
      id: "w_ref", title: "Ref Work", type: "short-video",
      status: "draft", platforms: ["douyin"], evaluation_mode: false,
      account_id: "acct_test_001",
      tags: [],
      created_at: now, updated_at: now,
    };
    createWork(work, []);
    expect(() => deleteAccount("acct_test_001")).toThrow("still reference it");
  });

  it("getWorksByAccount returns associated works", () => {
    createAccount(makeAccount());
    const now = new Date().toISOString();
    createWork({
      id: "w1", title: "Work 1", type: "short-video",
      status: "draft", platforms: ["douyin"], evaluation_mode: false,
      account_id: "acct_test_001",
      tags: [],
      created_at: now, updated_at: now,
    }, []);
    const works = getWorksByAccount("acct_test_001");
    expect(works).toHaveLength(1);
    expect(works[0].title).toBe("Work 1");
  });
});
