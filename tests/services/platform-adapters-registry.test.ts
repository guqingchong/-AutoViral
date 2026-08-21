import { describe, it, expect, beforeEach } from "vitest";
import { registerAdapter, getAdapter, listPlatforms, listAdapters, clearRegistry } from "../../src/services/platform-adapters/registry.js";
import type { PlatformAdapter, CollectedMetrics, CollectedComment, ReplyResult } from "../../src/services/platform-adapters/types.js";

class MockAdapter implements PlatformAdapter {
  readonly platform = "mock";
  readonly label = "Mock Platform";

  async collectAccountMetrics(): Promise<CollectedMetrics> {
    return { followers: 100, collectedAt: new Date().toISOString(), rawData: {} };
  }

  async collectPostMetrics(): Promise<CollectedMetrics> {
    return { views: 1000, likes: 100, collectedAt: new Date().toISOString(), rawData: {} };
  }

  async collectComments(): Promise<{ comments: CollectedComment[]; nextCursor?: string }> {
    return { comments: [] };
  }

  async publishReply(): Promise<ReplyResult> {
    return { success: true };
  }
}

describe("platform-adapters/registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("registers and retrieves an adapter", () => {
    const adapter = new MockAdapter();
    registerAdapter(adapter);
    expect(getAdapter("mock")).toBe(adapter);
  });

  it("lists platforms and adapters", () => {
    registerAdapter(new MockAdapter());
    expect(listPlatforms()).toEqual(["mock"]);
    expect(listAdapters().length).toBe(1);
  });

  it("throws on duplicate registration", () => {
    registerAdapter(new MockAdapter());
    expect(() => registerAdapter(new MockAdapter())).toThrow("already registered");
  });

  it("returns undefined for unregistered platform", () => {
    expect(getAdapter("unknown")).toBeUndefined();
  });
});

describe("platform key 归一(2026-08-21 终审 C1)", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("注册 wechat → 用账号侧键 wechat_mp 也能取到(双侧归一)", async () => {
    const { registerAdapterFactory, getAdapterForAccount, listPlatforms } = await import("../../src/services/platform-adapters/registry.js");
    registerAdapterFactory("wechat", () => new MockAdapter());
    expect(getAdapterForAccount("wechat_mp", "acc_1")).toBeDefined();
    expect(getAdapterForAccount("wechat_mp")).toBeDefined();
    expect(listPlatforms()).toEqual(["wechat"]);
  });

  it("注册别名键 wechat_mp 与 wechat 视为同一平台(重复注册报错)", async () => {
    const { registerAdapterFactory } = await import("../../src/services/platform-adapters/registry.js");
    registerAdapterFactory("wechat_mp", () => new MockAdapter());
    expect(() => registerAdapterFactory("wechat", () => new MockAdapter())).toThrow("already registered");
  });
});
