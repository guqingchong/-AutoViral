import type { PlatformAdapter } from "./types.js";
import { normalizePlatformKey } from "../credential-resolver.js";

/** 旧式直注册实例(无账号维度) */
const adapters = new Map<string, PlatformAdapter>();
/** 工厂注册:platform → (accountId?) => adapter */
const factories = new Map<string, (accountId?: string) => PlatformAdapter>();
/** 按账号实例缓存:键 `${platform}:${accountId ?? "default"}` */
const instances = new Map<string, PlatformAdapter>();

function instanceCacheKey(platform: string, accountId?: string): string {
  return `${platform}:${accountId ?? "default"}`;
}

/**
 * Register a platform adapter. Called once at server startup for each platform.
 * 平台键双侧归一(2026-08-21 终审 C1):wechat_mp 等账号侧键与注册侧键 wechat 视为同键。
 */
export function registerAdapter(adapter: PlatformAdapter): void {
  const platform = normalizePlatformKey(adapter.platform);
  if (adapters.has(platform) || factories.has(platform)) {
    throw new Error(`Platform adapter already registered: ${platform}`);
  }
  adapters.set(platform, adapter);
}

/**
 * Register an adapter factory for per-account instantiation (Task 7).
 * The factory receives the accountId (undefined = 平台默认/无账号调用)。
 */
export function registerAdapterFactory(
  platform: string,
  factory: (accountId?: string) => PlatformAdapter
): void {
  const key = normalizePlatformKey(platform);
  if (factories.has(key) || adapters.has(key)) {
    throw new Error(`Platform adapter already registered: ${key}`);
  }
  factories.set(key, factory);
}

/**
 * Get the adapter instance for a specific account.
 * 实例缓存键 `${platform}:${accountId ?? "default"}`;同参返回同一实例。
 * 平台仅有旧式直注册实例时,按账号获取回落到该共享实例。
 * platform 入参先归一:账号/发布记录侧键(wechat_mp)与注册键(wechat)等价。
 */
export function getAdapterForAccount(
  platform: string,
  accountId?: string
): PlatformAdapter | undefined {
  const key = normalizePlatformKey(platform);
  const factory = factories.get(key);
  if (!factory) {
    // 旧式直注册:无账号维度,共享同一实例
    return adapters.get(key);
  }
  const cacheKey = instanceCacheKey(key, accountId);
  const cached = instances.get(cacheKey);
  if (cached) return cached;
  const instance = factory(accountId);
  instances.set(cacheKey, instance);
  return instance;
}

/**
 * Get an adapter by platform key (e.g. "douyin", "kuaishou").
 * 兼容旧调用:等价于 getAdapterForAccount(platform, undefined)。
 */
export function getAdapter(platform: string): PlatformAdapter | undefined {
  return getAdapterForAccount(platform, undefined);
}

/**
 * All registered platform keys (归一后的注册侧键)。
 */
export function listPlatforms(): string[] {
  const keys = Array.from(adapters.keys());
  for (const platform of factories.keys()) {
    if (!adapters.has(platform)) keys.push(platform);
  }
  return keys;
}

/**
 * All registered adapters.
 * 工厂注册的平台以其默认(无账号)实例计入。
 */
export function listAdapters(): PlatformAdapter[] {
  const list = Array.from(adapters.values());
  for (const platform of factories.keys()) {
    if (adapters.has(platform)) continue;
    const instance = getAdapterForAccount(platform, undefined);
    if (instance) list.push(instance);
  }
  return list;
}

/**
 * Remove all adapters (useful in tests).
 */
export function clearRegistry(): void {
  adapters.clear();
  factories.clear();
  instances.clear();
}
