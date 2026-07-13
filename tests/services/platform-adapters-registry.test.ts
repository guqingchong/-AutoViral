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
