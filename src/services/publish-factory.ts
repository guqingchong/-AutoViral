import type { PlatformDriver } from "./publish-driver.js";
import { createMockDriver, SUPPORTED_PLATFORMS } from "./publish-drivers/mock-driver.js";

export function getDriver(platform: string): PlatformDriver {
  return createMockDriver(platform);
}

export function listSupportedPlatforms(): string[] {
  return [...SUPPORTED_PLATFORMS];
}
