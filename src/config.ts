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
  heygem?: {
    apiToken: string;
    baseUrl: string;              // 实例 6006 端口公网地址（AutoDL 控制台「自定义服务」）
    gpuHourlyRateYuan: number;    // GPU 时价，用于成本估算
    idleReminderMinutes: number;  // 空闲提醒阈值（默认 15）
  };
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
    if (parsed && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      delete rec.chanjing;
      delete rec.bailian;
      // 旧配置迁移：autodl.* → heygem.*（AutoDL API 控制已废弃，改手动控制实例）
      const legacy = rec.autodl as Record<string, unknown> | undefined;
      if (legacy && typeof legacy === "object") {
        const existing = (rec.heygem ?? {}) as Record<string, unknown>;
        rec.heygem = {
          apiToken: (existing.apiToken as string) ?? "",
          baseUrl: (legacy.publicBaseUrl as string) ?? (existing.baseUrl as string) ?? "",
          gpuHourlyRateYuan: (legacy.gpuHourlyRateYuan as number) ?? (existing.gpuHourlyRateYuan as number) ?? 1.78,
          idleReminderMinutes: (legacy.idleShutdownMinutes as number) ?? (existing.idleReminderMinutes as number) ?? 15,
        };
        delete rec.autodl;
      }
    }
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

    if (process.env.HEYGEM_API_TOKEN) {
      const h = config.heygem;
      config.heygem = {
        apiToken: process.env.HEYGEM_API_TOKEN,
        baseUrl: h?.baseUrl ?? "",
        gpuHourlyRateYuan: h?.gpuHourlyRateYuan ?? 1.78,
        idleReminderMinutes: h?.idleReminderMinutes ?? 15,
      };
    }
    if (process.env.HEYGEM_BASE_URL) {
      const h = config.heygem;
      config.heygem = {
        apiToken: h?.apiToken ?? "",
        baseUrl: process.env.HEYGEM_BASE_URL,
        gpuHourlyRateYuan: h?.gpuHourlyRateYuan ?? 1.78,
        idleReminderMinutes: h?.idleReminderMinutes ?? 15,
      };
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
