import type { PlatformDriver, PublishInput, PublishResult } from "../publish-driver.js";
import { PlatformNotSupportedError } from "../publish-driver.js";

export const SUPPORTED_PLATFORMS = [
  "tiktok",
  "xiaohongshu",
  "kuaishou",
  "bilibili",
  "zhihu",
  "wechat",
  "channels",
] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface MockDriverOptions {
  /**
   * If true, the driver's publish call will throw an error.
   * Use this in tests to simulate publish failures deterministically.
   */
  simulateFailure?: boolean;
  /**
   * Delay in milliseconds before the publish resolves (or rejects).
   * Set to 0 for synchronous-like behavior in tests.
   * @default 0
   */
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockDriver(platform: string, options: MockDriverOptions = {}): PlatformDriver {
  if (!SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
    throw new PlatformNotSupportedError(platform);
  }

  const delayMs = options.delayMs ?? 0;

  return {
    platform,
    async publish(input: PublishInput): Promise<PublishResult> {
      await sleep(delayMs);
      if (options.simulateFailure) {
        throw new Error(`Mock ${platform} publish failed: simulated failure`);
      }
      const publishedAt = new Date().toISOString();
      return {
        postUrl: `https://mock.${platform}.com/posts/${Buffer.from(input.title).toString("base64url")}`,
        publishedAt,
      };
    },
  };
}
