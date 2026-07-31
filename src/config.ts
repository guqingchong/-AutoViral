import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import dotenv from "dotenv";
import type { AnalyticsSource } from "./services/platform-adapters/types.js";

dotenv.config();

let cachedConfig: Config | undefined;

export interface Config {
  port: number;
  model: string;
  jimeng: { accessKey: string; secretKey: string };
  openrouter?: { apiKey: string };
  minimax?: { apiKey: string };
  autodl?: {
    token: string;           // AutoDL 开发者 Token
    instanceUuid: string;    // 实例 ID
    publicBaseUrl: string;   // https://{uuid}.{region}.autodl.com
    gpuHourlyRateYuan: number;
    idleShutdownMinutes: number;
  };
  heygem?: { apiToken: string };
  pexels?: { apiKey: string };
  pixabay?: { apiKey: string };
  unsplash?: { accessKey: string };
  research: { enabled: boolean; schedule: string; platforms: string[] };
  interests?: string[];
  memory?: { apiKey: string; userId: string; syncEnabled: boolean };
  analytics: {
    enabled: boolean;
    collectInterval: number; // minutes
    sources: AnalyticsSource[];
  };
  /** Phase 5: self-evolution configuration */
  evolution?: {
    enabled: boolean;
    autoApply: boolean;
    minConfidence: number;
  };
  /** PRD 4.3.6: budget control */
  budget?: {
    monthlyLimitYuan: number;
    dailyLimitYuan: number;
    warningThresholdPercent: number;
  };
}

export type { AnalyticsSource };

const CONFIG_DIR = process.env.AUTOVIRAL_DATA_DIR
  ? process.env.AUTOVIRAL_DATA_DIR
  : join(homedir(), ".autoviral");

const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

/** Base data directory for works, trends, etc. */
export const dataDir = CONFIG_DIR;

export function getDefaultConfig(): Config {
  return {
    port: 3271,
    model: "opus",
    jimeng: { accessKey: "", secretKey: "" },
    research: { enabled: true, schedule: "0 9,21 * * *", platforms: ["douyin", "xiaohongshu", "weibo", "zhihu", "bilibili"] },
    interests: [],
    analytics: { enabled: false, collectInterval: 60, sources: [] },
    budget: { monthlyLimitYuan: 2500, dailyLimitYuan: 200, warningThresholdPercent: 80 },
  };
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Migrate legacy analytics configuration to the new multi-source format.
 * Backwards-compatible: old analytics.douyinUrl becomes a cookie/rpa source.
 */
function migrateOldAnalytics(config: Config): Config {
  const old = (config as unknown as Record<string, unknown>).analytics as Record<string, unknown> | undefined;
  if (old && typeof old.douyinUrl === "string" && old.douyinUrl) {
    config.analytics.sources.push({
      platform: "douyin",
      authType: "cookie",
      accountUrl: old.douyinUrl,
      credentials: {},
    });
    delete old.douyinUrl;
  }
  return config;
}

export function getConfig(): Config {
  return cachedConfig ?? getDefaultConfig();
}

export async function loadConfig(): Promise<Config> {
  await ensureDir(CONFIG_DIR);
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = yaml.load(raw) as Partial<Config> | null;
    const config: Config = { ...getDefaultConfig(), ...parsed };
    config.interests = config.interests ?? [];
    config.analytics = config.analytics ?? getDefaultConfig().analytics;
    config.analytics.sources = config.analytics.sources ?? [];
    migrateOldAnalytics(config);

    // .env overrides
    if (process.env.JIMENG_ACCESS_KEY) {
      config.jimeng.accessKey = process.env.JIMENG_ACCESS_KEY;
    }
    if (process.env.JIMENG_SECRET_KEY) {
      config.jimeng.secretKey = process.env.JIMENG_SECRET_KEY;
    }
    if (process.env.OPENROUTER_API_KEY) {
      config.openrouter = { apiKey: process.env.OPENROUTER_API_KEY };
    }
    if (process.env.MINIMAX_API_KEY) {
      config.minimax = { apiKey: process.env.MINIMAX_API_KEY };
    }
    if (process.env.EVERMEMOS_API_KEY) {
      if (!config.memory) {
        config.memory = { apiKey: "", userId: "autoviral-user", syncEnabled: false };
      }
      config.memory.apiKey = process.env.EVERMEMOS_API_KEY;
    }

    if (process.env.AUTODL_TOKEN) {
      config.autodl = { ...(config.autodl ?? { token: "", instanceUuid: "", publicBaseUrl: "", gpuHourlyRateYuan: 2.18, idleShutdownMinutes: 15 }), token: process.env.AUTODL_TOKEN };
    }
    if (process.env.HEYGEM_API_TOKEN) {
      config.heygem = { apiToken: process.env.HEYGEM_API_TOKEN };
    }

    cachedConfig = config;
    return config;
  } catch {
    const config = getDefaultConfig();
    await saveConfig(config);
    return config;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureDir(CONFIG_DIR);
  const raw = yaml.dump(config, { lineWidth: -1 });
  await writeFile(CONFIG_PATH, raw, "utf-8");
  cachedConfig = config;
}

export function getConfigDir(): string {
  return process.env.AUTOVIRAL_DATA_DIR
    ? process.env.AUTOVIRAL_DATA_DIR
    : join(homedir(), ".autoviral");
}
