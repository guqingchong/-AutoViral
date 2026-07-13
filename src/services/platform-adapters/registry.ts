import type { PlatformAdapter } from "./types.js";

const adapters = new Map<string, PlatformAdapter>();

/**
 * Register a platform adapter. Called once at server startup for each platform.
 */
export function registerAdapter(adapter: PlatformAdapter): void {
  if (adapters.has(adapter.platform)) {
    throw new Error(`Platform adapter already registered: ${adapter.platform}`);
  }
  adapters.set(adapter.platform, adapter);
}

/**
 * Get an adapter by platform key (e.g. "douyin", "kuaishou").
 */
export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.get(platform);
}

/**
 * All registered platform keys.
 */
export function listPlatforms(): string[] {
  return Array.from(adapters.keys());
}

/**
 * All registered adapters.
 */
export function listAdapters(): PlatformAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Remove all adapters (useful in tests).
 */
export function clearRegistry(): void {
  adapters.clear();
}
