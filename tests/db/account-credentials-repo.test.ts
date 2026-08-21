import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import {
  setAccountCredential,
  getAccountCredential,
  deleteAccountCredentialsByAccount,
} from "../../src/db/account-credentials-repo.js";

describe("account-credentials-repo", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    getDb().prepare(
      "INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','测试号','douyin','active','2026-01-01','2026-01-01')"
    ).run();
  });
  afterEach(() => closeDb());

  it("set 后可 get 取回", () => {
    setAccountCredential("a1", "session_cookie", "v1");
    expect(getAccountCredential("a1", "session_cookie")).toBe("v1");
  });

  it("同 (account_id,key_type) 重复 set 走 upsert 覆盖", () => {
    setAccountCredential("a1", "session_cookie", "v1");
    setAccountCredential("a1", "session_cookie", "v2");
    expect(getAccountCredential("a1", "session_cookie")).toBe("v2");
    const count = getDb()
      .prepare("SELECT COUNT(*) FROM account_credentials WHERE account_id = 'a1' AND key_type = 'session_cookie'")
      .pluck().get();
    expect(count).toBe(1);
  });

  it("未命中返回 undefined", () => {
    expect(getAccountCredential("a1", "missing")).toBeUndefined();
    expect(getAccountCredential("no-such-account", "session_cookie")).toBeUndefined();
  });

  it("deleteAccountCredentialsByAccount 只删该账号的凭证", () => {
    getDb().prepare(
      "INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a2','另一个号','douyin','active','2026-01-02','2026-01-02')"
    ).run();
    setAccountCredential("a1", "k1", "x");
    setAccountCredential("a1", "k2", "y");
    setAccountCredential("a2", "k1", "z");

    deleteAccountCredentialsByAccount("a1");

    expect(getAccountCredential("a1", "k1")).toBeUndefined();
    expect(getAccountCredential("a1", "k2")).toBeUndefined();
    expect(getAccountCredential("a2", "k1")).toBe("z");
  });
});
