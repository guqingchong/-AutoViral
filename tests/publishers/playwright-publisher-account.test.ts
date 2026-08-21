import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import { createAccount } from "../../src/db/accounts-repo.js";
import { setAccountCredential } from "../../src/db/account-credentials-repo.js";
import { dataDir } from "../../src/config.js";

// 不真开浏览器:mock chromium.launchPersistentContext,验证画像目录/context Map/播种逻辑
const launchCalls: string[] = [];
const mockAddCookies = vi.fn();
const mockClose = vi.fn(async () => {});

function makeFakeContext(existingCookies: unknown[] = []) {
  return {
    cookies: async () => existingCookies,
    addCookies: mockAddCookies,
    newPage: async () => ({ close: async () => {} }),
    close: mockClose,
  };
}

vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: vi.fn(async (profileDir: string) => {
      launchCalls.push(profileDir);
      return makeFakeContext();
    }),
  },
}));

import {
  PlaywrightPublisher,
  resolveProfileDir,
} from "../../src/services/publishers/playwright-publisher.js";
import { resolvePublisher } from "../../src/services/publishing.js";
import type { PublishInput, PublishOutput } from "../../src/services/publishers/types.js";
import type { Page } from "playwright";

const PLATFORM = "test-acc-platform";
const COOKIE = JSON.stringify([{ name: "s", value: "1", domain: ".example.com", path: "/" }]);

class AccountTestPublisher extends PlaywrightPublisher {
  readonly platform = PLATFORM;
  readonly name = "账号测试平台";
  readonly loginUrl = "https://test.example/login";
  readonly uploadUrl = "https://test.example/upload";
  protected override async checkLoggedIn(_page: Page): Promise<boolean> {
    return true;
  }
  protected override async doUpload(_page: Page, _input: PublishInput): Promise<PublishOutput> {
    return { success: true };
  }
}

function seedAccount(id: string, platform = PLATFORM, isDefault = 0) {
  createAccount({
    id,
    name: id,
    platform,
    tone_profile: {},
    status: "active",
    is_default: isDefault,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

describe("resolveProfileDir(纯函数)", () => {
  it("同平台两账号画像目录不同", () => {
    const a = resolveProfileDir("douyin", "acc-1");
    const b = resolveProfileDir("douyin", "acc-2");
    expect(a).not.toBe(b);
    expect(a).toBe(join(dataDir, "browser-profiles", "douyin", "acc-1"));
    expect(b).toBe(join(dataDir, "browser-profiles", "douyin", "acc-2"));
  });

  it("无 accountId 落 legacy 目录", () => {
    expect(resolveProfileDir("douyin")).toBe(
      join(dataDir, "browser-profiles", "douyin", "legacy")
    );
    expect(resolveProfileDir("douyin", undefined)).toBe(resolveProfileDir("douyin"));
  });
});

describe("PlaywrightPublisher 多账号", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    launchCalls.length = 0;
    mockAddCookies.mockClear();
    mockClose.mockClear();
  });
  afterEach(() => closeDb());

  it("isConfigured(accountId) 读账号凭证而非平台单例", async () => {
    seedAccount("acc-with-cookie");
    setAccountCredential("acc-with-cookie", "session_cookie", COOKIE);
    // 平台旧表无凭证 —— 若仍读旧表则 false
    const pub = new AccountTestPublisher();
    expect(await pub.isConfigured("acc-with-cookie")).toBe(true);
  });

  it("isConfigured 对无凭证账号返回 false(孤立平台,无任何兜底)", async () => {
    seedAccount("acc-no-cookie");
    const pub = new AccountTestPublisher();
    expect(await pub.isConfigured("acc-no-cookie")).toBe(false);
  });

  it("isConfigured() 无 accountId 兼容旧行为(读平台旧表兜底)", async () => {
    setCredential(PLATFORM, "session_cookie", COOKIE);
    const pub = new AccountTestPublisher();
    expect(await pub.isConfigured()).toBe(true);
  });

  it("ensureBrowser 按账号建独立 context,画像目录按账号隔离", async () => {
    const pub = new AccountTestPublisher();
    await pub.ensureBrowser("acc-1");
    await pub.ensureBrowser("acc-2");
    await pub.ensureBrowser();
    expect(launchCalls).toEqual([
      join(dataDir, "browser-profiles", PLATFORM, "acc-1"),
      join(dataDir, "browser-profiles", PLATFORM, "acc-2"),
      join(dataDir, "browser-profiles", PLATFORM, "legacy"),
    ]);
  });

  it("ensureBrowser 同账号复用已建 context(不重复 launch)", async () => {
    const pub = new AccountTestPublisher();
    const first = await pub.ensureBrowser("acc-1");
    const second = await pub.ensureBrowser("acc-1");
    expect(launchCalls.length).toBe(1);
    expect(second.context).toBe(first.context);
  });

  it("空画像从指定账号凭证播种 cookie", async () => {
    seedAccount("acc-seed");
    setAccountCredential("acc-seed", "session_cookie", COOKIE);
    const pub = new AccountTestPublisher();
    await pub.ensureBrowser("acc-seed");
    expect(mockAddCookies).toHaveBeenCalledWith(JSON.parse(COOKIE));
  });

  it("close() 关闭全部账号 context", async () => {
    const pub = new AccountTestPublisher();
    await pub.ensureBrowser("acc-1");
    await pub.ensureBrowser("acc-2");
    await pub.close();
    expect(mockClose).toHaveBeenCalledTimes(2);
    // close 后再 ensureBrowser 需重开
    await pub.ensureBrowser("acc-1");
    expect(launchCalls.length).toBe(3);
  });
});

describe("publishing publisherCache 按账号隔离", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("同平台不同账号返回不同发布器实例;无 accountId 落 legacy 单例", () => {
    const a1 = resolvePublisher("douyin", "acc-a");
    const a2 = resolvePublisher("douyin", "acc-a");
    const b = resolvePublisher("douyin", "acc-b");
    const legacy1 = resolvePublisher("douyin");
    const legacy2 = resolvePublisher("douyin");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(legacy1).toBe(legacy2);
    expect(legacy1).not.toBe(a1);
  });
});
