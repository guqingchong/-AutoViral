import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

describe("migrate v29", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("创建 account_credentials 表及唯一约束", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','测试号','douyin','active','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO account_credentials (account_id, key_type, value) VALUES ('a1','session_cookie','x')").run();
    expect(() =>
      db.prepare("INSERT INTO account_credentials (account_id, key_type, value) VALUES ('a1','session_cookie','y')").run()
    ).toThrow();
  });

  it("publish_records / platform_metrics / topic_scores 有 account_id/platform 列", () => {
    const db = getDb();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols("publish_records")).toContain("account_id");
    expect(cols("platform_metrics")).toContain("account_id");
    expect(cols("accounts")).toContain("is_default");
    expect(cols("topic_scores")).toContain("platform");
  });

  it("幂等:重复执行 migrate 不报错", () => {
    expect(() => migrate()).not.toThrow();
  });
});
