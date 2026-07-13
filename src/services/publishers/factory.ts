import type { Publisher } from "./types.js";

const registry = new Map<string, () => Publisher>();

export function registerPublisher(platform: string, factory: () => Publisher): void {
  registry.set(platform, factory);
}

export function getPublisher(platform: string): Publisher {
  const factory = registry.get(platform);
  if (!factory) {
    throw new Error(`No publisher registered for platform: ${platform}`);
  }
  return factory();
}

export function listPublishers(): string[] {
  return Array.from(registry.keys());
}
