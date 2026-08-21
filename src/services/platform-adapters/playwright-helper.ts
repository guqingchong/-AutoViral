/**
 * Playwright browser helper for scraping-based platform adapters (Douyin, Xiaohongshu).
 *
 * Maintains a persistent browser context so login cookies survive restarts.
 * Contexts are keyed by contextKey = "<platform>:<accountId ?? "default">";
 * 画像目录为两级:PROFILE_DIR/<platform>/<accountId>(Task 7,旧目录不迁移)。
 */

import { chromium, type Browser, type BrowserContext } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PROFILE_DIR = join(homedir(), ".autoviral", "browser-profiles");

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();

/**
 * contextKey → 画像目录。"douyin:a1" → PROFILE_DIR/douyin/a1(冒号分段 → 两级目录);
 * 无冒号的旧式键(如 "douyin")→ 单级 PROFILE_DIR/douyin。
 */
export function resolveProfileDir(contextKey: string): string {
  return join(PROFILE_DIR, ...contextKey.split(":"));
}

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) {
    mkdirSync(PROFILE_DIR, { recursive: true });
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function getContext(
  contextKey: string,
  storageStateFile?: string
): Promise<BrowserContext> {
  const existing = contexts.get(contextKey);
  if (existing) return existing;

  const b = await getBrowser();
  const profileDir = resolveProfileDir(contextKey);
  mkdirSync(profileDir, { recursive: true });

  const statePath = storageStateFile ?? join(profileDir, "state.json");
  const ctx = existsSync(statePath)
    ? await b.newContext({ storageState: statePath })
    : await b.newContext();

  contexts.set(contextKey, ctx);
  return ctx;
}

export async function saveState(contextKey: string): Promise<void> {
  const ctx = contexts.get(contextKey);
  if (!ctx) return;
  const statePath = join(resolveProfileDir(contextKey), "state.json");
  await ctx.storageState({ path: statePath });
}

export async function closeContext(contextKey: string): Promise<void> {
  const ctx = contexts.get(contextKey);
  if (ctx) {
    await ctx.close();
    contexts.delete(contextKey);
  }
}

export async function closeBrowser(): Promise<void> {
  for (const contextKey of contexts.keys()) {
    await closeContext(contextKey);
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}
