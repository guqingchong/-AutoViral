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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockDriver(platform: string): PlatformDriver {
  if (!SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
    throw new PlatformNotSupportedError(platform);
  }

  return {
    platform,
    async publish(input: PublishInput): Promise<PublishResult> {
      await sleep(1000 + Math.random() * 2000);
      if (Math.random() < 0.05) {
        throw new Error(`Mock ${platform} publish failed: network error`);
      }
      const publishedAt = new Date().toISOString();
      return {
        postUrl: `https://mock.${platform}.com/posts/${Buffer.from(input.title).toString("base64url")}`,
        publishedAt,
      };
    },
  };
}
