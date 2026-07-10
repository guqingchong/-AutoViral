import type { PlatformDriver } from "./publish-driver.js";
import { createMockDriver } from "./publish-drivers/mock-driver.js";

export function getDriver(platform: string): PlatformDriver {
  return createMockDriver(platform);
}

export function listSupportedPlatforms(): string[] {
  return ["tiktok", "xiaohongshu", "kuaishou", "bilibili", "zhihu", "wechat", "channels"];
}
