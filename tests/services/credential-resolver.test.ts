import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb, getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setAccountCredential } from "../../src/db/account-credentials-repo.js";
import {
  normalizePlatformKey,
  resolveAccountCredential,
} from "../../src/services/credential-resolver.js";

function addAccount(id: string, platform: string, opts: { isDefault?: number; status?: string | null; createdAt?: string } = {}) {
  const created = opts.createdAt ?? "2026-01-01";
  getDb().prepare(
    "INSERT INTO accounts (id, name, platform, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, `号-${id}`, platform, opts.status === undefined ? "active" : opts.status, opts.isDefault ?? 0, created, created);
}

describe("normalizePlatformKey", () => {
  it("wechat_mp → wechat,其余原样", () => {
    expect(normalizePlatformKey("wechat_mp")).toBe("wechat");
    expect(normalizePlatformKey("wechat")).toBe("wechat");
    expect(normalizePlatformKey("douyin")).toBe("douyin");
  });
});

describe("resolveAccountCredential", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    closeDb();
  });

  it("① 指定账号命中 → 返回该账号值", () => {
    addAccount("a1", "douyin", { isDefault: 1, createdAt: "2026-01-01" });
    addAccount("a2", "douyin", { createdAt: "2026-02-01" });
    setAccountCredential("a1", "session_cookie", "default-val");
    setAccountCredential("a2", "session_cookie", "specified-val");

    expect(resolveAccountCredential("douyin", "a2", "session_cookie")).toBe("specified-val");
  });

  it("② 不指定账号 → 返回 is_default=1 账号的值", () => {
    addAccount("a1", "douyin", { isDefault: 0, createdAt: "2026-01-01" });
    addAccount("a2", "douyin", { isDefault: 1, createdAt: "2026-02-01" });
    setAccountCredential("a1", "session_cookie", "nondefault-val");
    setAccountCredential("a2", "session_cookie", "default-val");

    expect(resolveAccountCredential("douyin", undefined, "session_cookie")).toBe("default-val");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("③ 无默认但有活跃账号 → 返回该活跃账号值并告警", () => {
    addAccount("a1", "douyin", { isDefault: 0, createdAt: "2026-01-01" });
    setAccountCredential("a1", "session_cookie", "active-val");

    expect(resolveAccountCredential("douyin", undefined, "session_cookie")).toBe("active-val");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("③b 默认账号不活跃 → 回落活跃账号(告警)", () => {
    addAccount("a1", "douyin", { isDefault: 1, status: "disabled", createdAt: "2026-01-01" });
    addAccount("a2", "douyin", { isDefault: 0, createdAt: "2026-02-01" });
    setAccountCredential("a1", "session_cookie", "disabled-val");
    setAccountCredential("a2", "session_cookie", "active-val");

    expect(resolveAccountCredential("douyin", undefined, "session_cookie")).toBe("active-val");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("④ 新表全无 → 回落旧 platform_credentials", () => {
    addAccount("a1", "douyin", { isDefault: 1 });
    getDb().prepare(
      "INSERT INTO platform_credentials (platform, key_type, value) VALUES ('douyin','session_cookie','legacy-val')"
    ).run();

    expect(resolveAccountCredential("douyin", undefined, "session_cookie")).toBe("legacy-val");
  });

  it("⑤ 全无 → undefined", () => {
    expect(resolveAccountCredential("douyin", undefined, "session_cookie")).toBeUndefined();
  });

  it("⑥ wechat_mp 平台解析时旧表兜底读 wechat 键", () => {
    getDb().prepare(
      "INSERT INTO platform_credentials (platform, key_type, value) VALUES ('wechat','app_secret','wx-secret')"
    ).run();

    expect(resolveAccountCredential("wechat_mp", undefined, "app_secret")).toBe("wx-secret");
  });
});
