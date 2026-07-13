/**
 * Playwright browser helper for scraping-based platform adapters (Douyin, Xiaohongshu).
 *
 * Maintains a persistent browser context so login cookies survive restarts.
 * Each scraper gets its own context keyed by platform name.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROFILE_DIR = join(homedir(), ".autoviral", "browser-profiles");

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function getContext(
  platform: string,
  storageStateFile?: string
): Promise<BrowserContext> {
  const existing = contexts.get(platform);
  if (existing) return existing;

  const b = await getBrowser();
  const profileDir = join(PROFILE_DIR, platform);
  mkdirSync(profileDir, { recursive: true });

  const statePath = storageStateFile ?? join(profileDir, "state.json");
  const ctx = existsSync(statePath)
    ? await b.newContext({ storageState: statePath })
    : await b.newContext();

  contexts.set(platform, ctx);
  return ctx;
}

export async function saveState(platform: string): Promise<void> {
  const ctx = contexts.get(platform);
  if (!ctx) return;
  const statePath = join(PROFILE_DIR, platform, "state.json");
  await ctx.storageState({ path: statePath });
}

export async function closeContext(platform: string): Promise<void> {
  const ctx = contexts.get(platform);
  if (ctx) {
    await ctx.close();
    contexts.delete(platform);
  }
}

export async function closeBrowser(): Promise<void> {
  for (const platform of contexts.keys()) {
    await closeContext(platform);
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}
