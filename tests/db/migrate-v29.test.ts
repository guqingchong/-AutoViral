import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate, backfillV29Accounts } from "../../src/db/migrate.js";

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

describe("backfillV29Accounts", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("凭证搬迁:旧表值迁入默认账号,ON CONFLICT 不覆盖已有新凭证", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','抖音号','douyin','active','2026-01-01','2026-01-01')").run();
    // 已手工配置的新凭证,回填不得覆盖
    db.prepare("INSERT INTO account_credentials (account_id, key_type, value) VALUES ('a1','session_cookie','new-val')").run();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','session_cookie','old-val')").run();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','refresh_token','rt-1')").run();

    backfillV29Accounts();

    const kept = db.prepare("SELECT value FROM account_credentials WHERE account_id = 'a1' AND key_type = 'session_cookie'").pluck().get();
    expect(kept).toBe("new-val");
    const migrated = db.prepare("SELECT value FROM account_credentials WHERE account_id = 'a1' AND key_type = 'refresh_token'").pluck().get();
    expect(migrated).toBe("rt-1");
  });

  it("wechat 别名:占位账号建在 wechat_mp 下,凭证仍按原 platform 搬迁", () => {
    const db = getDb();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('wechat','app_secret','s-1')").run();

    backfillV29Accounts();

    const account = db.prepare("SELECT id, platform, is_default FROM accounts WHERE platform = 'wechat_mp'").get() as
      { id: string; platform: string; is_default: number } | undefined;
    expect(account).toBeDefined();
    expect(account!.is_default).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM accounts WHERE platform = 'wechat'").pluck().get()).toBe(0);
    const cred = db.prepare("SELECT value FROM account_credentials WHERE account_id = ? AND key_type = 'app_secret'").pluck().get(account!.id);
    expect(cred).toBe("s-1");
  });

  it("is_default:每平台恰一个默认账号(取最早创建),重复调用幂等", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','早号','douyin','active','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a2','晚号','douyin','active','2026-02-01','2026-02-01')").run();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','session_cookie','x')").run();

    backfillV29Accounts();
    backfillV29Accounts();

    expect(db.prepare("SELECT is_default FROM accounts WHERE id = 'a1'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT is_default FROM accounts WHERE id = 'a2'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM accounts WHERE platform = 'douyin' AND is_default = 1").pluck().get()).toBe(1);
    // 凭证重复搬迁不产生重复行
    expect(db.prepare("SELECT COUNT(*) FROM account_credentials WHERE account_id = 'a1' AND key_type = 'session_cookie'").pluck().get()).toBe(1);
  });

  it("publish_records:只补 NULL 的 account_id,已有值不改写", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','抖音号','douyin','active','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','session_cookie','x')").run();
    db.prepare("INSERT INTO publish_records (work_id, platform) VALUES ('w-null','douyin')").run();
    db.prepare("INSERT INTO publish_records (work_id, platform, account_id) VALUES ('w-manual','douyin','manual-acc')").run();

    backfillV29Accounts();

    expect(db.prepare("SELECT account_id FROM publish_records WHERE work_id = 'w-null'").pluck().get()).toBe("a1");
    expect(db.prepare("SELECT account_id FROM publish_records WHERE work_id = 'w-manual'").pluck().get()).toBe("manual-acc");
  });

  // 2026-08-21 终审 I1:backfill 此前每次 migrate() 都清 0 再置 1(最早创建者),
  // 用户手设的默认账号在每次服务重启时被静默翻转。已有 is_default=1 则跳过指派。
  it("用户手设的默认账号不被重跑回填翻转", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','早号','douyin','active','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a2','晚号','douyin','active','2026-02-01','2026-02-01')").run();
    db.prepare("INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','session_cookie','x')").run();
    // 用户手工把晚号设为默认
    db.prepare("UPDATE accounts SET is_default = 1 WHERE id = 'a2'").run();

    backfillV29Accounts();
    backfillV29Accounts();

    expect(db.prepare("SELECT is_default FROM accounts WHERE id = 'a2'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT is_default FROM accounts WHERE id = 'a1'").pluck().get()).toBe(0);
    // 凭证搬迁不受影响(仍迁到最早创建账号,ON CONFLICT 不覆盖)
    expect(db.prepare("SELECT value FROM account_credentials WHERE account_id = 'a1' AND key_type = 'session_cookie'").pluck().get()).toBe("x");
  });
});
