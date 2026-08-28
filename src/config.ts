import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import dotenv from "dotenv";
import type { AnalyticsSource } from "./services/platform-adapters/types.js";

dotenv.config();

let cachedConfig: Config | undefined;

export interface HeygemTunnelConfig {
  host: string;        // SSH 跳板主机（AutoDL 实例 SSH 地址）
  port: number;        // SSH 端口
  user: string;        // SSH 用户
  localPort: number;   // 本地转发端口（heygem.baseUrl 指向它）
  remotePort: number;  // 实例内 HeyGem API 端口
}

// ── LLM 直连配置（2026-08-16 架构改造，docs/desigen/01 §3.6）─────────────────

export interface LlmProviderConfig {
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  /** 视觉模型（评审看图/模板克专用）；不配则该 provider 不可用于看图场景（配置校验期报错） */
  visionModel?: string;
  /** 启用开关（设置页「大模型直连」卡片,2026-08-17 P1-T7）；false 时该 provider 不参与路由，缺省视为启用 */
  enabled?: boolean;
  /** 多轮回填 reasoning_content（Kimi thinking 模式必须；DeepSeek 必须不回填）。缺省走预设 */
  passReasoningBack?: boolean;
}

export interface LlmConfig {
  /** providers 里的 key，裸模型名路由时使用 */
  defaultProvider?: string;
  /** 首期三家：deepseek / kimi / glm（均为 OpenAI 兼容协议） */
  providers?: Record<string, LlmProviderConfig>;
  /** 分阶段模型路由：值形如 "deepseek:deepseek-v4-pro" 或裸模型名（走 defaultProvider） */
  models?: Partial<Record<"research" | "plan" | "assets" | "assembly" | "eval" | "script", string>>;
  /** 批次7.4:无视觉要求阶段(research/plan/material-search)评审的轻量模型("provider:model"),
   *  设置后这些阶段的评审从 eval 档降档到该模型(机械项已被机器门禁覆盖,评审只需轻判断);
   *  assets/assembly 必须看图,恒走 eval 档+视觉路由,不受此影响 */
  evalLightModel?: string;
  /** 可选价格表（元/百万 tokens），用于 llm_usage 成本估算：{ "deepseek:deepseek-v4-pro": {input:4.5, output:13.5, cacheRead:0.15} } */
  priceTable?: Record<string, { input: number; output: number; cacheRead?: number }>;
  guard?: {
    maxStepsPerTurn?: number;    // 默认 200，防工具死循环
    maxTurnMinutes?: number;     // 默认 30
    dailyTokenBudget?: number;   // 成本熔断
    bashBlocklist?: string[];    // bash 命令黑名单正则
    evalTimeoutMinutes?: number; // 评审器硬超时,默认 15(2026-08-28 批次1.2:防评审器无限挂起)
  };
}

/** SSH 隧道默认值：AutoDL 个人用户无公网代理权限，只能通过 SSH 隧道访问实例服务 */
export const HEYGEM_TUNNEL_DEFAULTS: HeygemTunnelConfig = {
  host: "connect.nmb1.seetacloud.com",
  port: 28830,
  user: "root",
  localPort: 6006,
  remotePort: 6008,
};

export interface H3TunnelConfig {
  host: string;        // SSH 跳板主机（AutoDL 实例 SSH 地址）
  port: number;        // SSH 端口
  user: string;        // SSH 用户
  localPort: number;   // 本地转发端口（h3.baseUrl 指向它）
  remotePort: number;  // 实例内 ComfyUI API 端口
}

/** H3 隧道默认值：与 heygem 共用同一 AutoDL 实例（2026-08-10 实例 9be34da8eb），ComfyUI 监听 8188 */
export const H3_TUNNEL_DEFAULTS: H3TunnelConfig = {
  host: "connect.nmb1.seetacloud.com",
  port: 27128,
  user: "root",
  localPort: 8188,
  remotePort: 8188,
};

export interface Config {
  port: number;
  model: string;
  /** LLM 直连（API agent loop）。未配置时维持 CLI 现状——零迁移成本 */
  llm?: LlmConfig;
  jimeng: { accessKey: string; secretKey: string };
  openrouter?: { apiKey: string };
  minimax?: { apiKey: string; groupId?: string };
  zhihuData?: { accessSecret: string };  // 知乎数据开放平台 Access Secret（developer.zhihu.com 个人中心）
  heygem?: {
    apiToken: string;
    baseUrl: string;              // 实例 API 地址（SSH 隧道模式默认 http://localhost:6006）
    gpuHourlyRateYuan: number;    // GPU 时价，用于成本估算
    idleReminderMinutes: number;  // 空闲提醒阈值（默认 15）
    tunnel?: HeygemTunnelConfig;  // SSH 隧道（缺省时按 HEYGEM_TUNNEL_DEFAULTS 补全）
    /** 多实例候选:常开多台 AutoDL 实例时全部列入,隧道按序尝试、哪个能用用哪个。优先于单数 tunnel */
    tunnels?: HeygemTunnelConfig[];
  };
  /** MiniMax H3 本地视频生成（AutoDL ComfyUI）。不配则不注册 local-h3 provider */
  h3?: {
    baseUrl?: string;              // ComfyUI API 地址（SSH 隧道模式默认 http://localhost:8188）
    gpuHourlyRateYuan?: number;    // GPU 时价，用于成本估算（默认 2.18）
    idleReminderMinutes?: number;  // 空闲提醒阈值（默认 30）
    tunnel?: H3TunnelConfig;       // SSH 隧道（缺省时按 H3_TUNNEL_DEFAULTS 补全）
    /** 多实例候选:常开多台 AutoDL 实例时全部列入,隧道按序尝试、哪个能用用哪个。优先于单数 tunnel */
    tunnels?: H3TunnelConfig[];
  };
  pexels?: { apiKey: string };
  pixabay?: { apiKey: string };
  unsplash?: { accessKey: string };
  /** 数字人渲染池：攒批阈值（默认 3），达到后集中提交渲染 */
  digitalHuman?: { batchThreshold?: number };
  research: { enabled: boolean; schedule: string; platforms: string[]; topN?: number };
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
    research: { enabled: true, schedule: "0 9,21 * * *", platforms: ["douyin", "xiaohongshu", "bilibili", "zhihu", "kuaishou", "channels", "wechat_mp"], topN: 10 },
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
    if (process.env.MINIMAX_API_KEY && !config.minimax?.apiKey) {
      // 仅在 YAML 未配置时兜底：设置页可填 minimaxKey，若 env 永远优先，
      // 用户在设置页保存的 key 会被静默屏蔽（2026-08-04 设置页显性化修复）
      config.minimax = { apiKey: process.env.MINIMAX_API_KEY };
    }
    // LLM 直连 env 覆盖（2026-08-16）：同样遵守"YAML 优先、env 兜底"原则
    if (process.env.AUTOVIRAL_LLM_API_KEY || process.env.AUTOVIRAL_LLM_BASE_URL) {
      const key = config.llm?.defaultProvider ?? "deepseek";
      const existing = config.llm?.providers?.[key];
      config.llm = {
        ...config.llm,
        defaultProvider: key,
        providers: {
          ...config.llm?.providers,
          [key]: {
            protocol: existing?.protocol ?? "openai",
            baseUrl: existing?.baseUrl ?? process.env.AUTOVIRAL_LLM_BASE_URL ?? "https://api.deepseek.com/v1",
            apiKey: existing?.apiKey || (process.env.AUTOVIRAL_LLM_API_KEY ?? ""),
            visionModel: existing?.visionModel,
          },
        },
      };
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
        tunnel: h?.tunnel,
      };
    }
    if (process.env.HEYGEM_BASE_URL) {
      const h = config.heygem;
      config.heygem = {
        apiToken: h?.apiToken ?? "",
        baseUrl: process.env.HEYGEM_BASE_URL,
        gpuHourlyRateYuan: h?.gpuHourlyRateYuan ?? 1.78,
        idleReminderMinutes: h?.idleReminderMinutes ?? 15,
        tunnel: h?.tunnel,
      };
    }

    // 旧配置兼容：heygem 存在但缺 tunnel 字段（或字段不全）时补默认值；
    // SSH 隧道模式下 baseUrl 为空时默认指向本地隧道端口
    if (config.heygem) {
      config.heygem.tunnel = { ...HEYGEM_TUNNEL_DEFAULTS, ...(config.heygem.tunnel ?? {}) };
      if (config.heygem.tunnels) {
        config.heygem.tunnels = config.heygem.tunnels.map((t) => ({ ...HEYGEM_TUNNEL_DEFAULTS, ...t }));
      }
      if (!config.heygem.baseUrl) {
        config.heygem.baseUrl = `http://localhost:${config.heygem.tunnel.localPort}`;
      }
    }

    // h3 与 heygem 同理：补隧道默认值，baseUrl 缺省指向本地隧道端口。
    // 用户只写 `h3: {}` 即可启用（默认值指向 PoC 验证过的实例 9be34da8eb）。
    if (config.h3) {
      config.h3.tunnel = { ...H3_TUNNEL_DEFAULTS, ...(config.h3.tunnel ?? {}) };
      if (config.h3.tunnels) {
        config.h3.tunnels = config.h3.tunnels.map((t) => ({ ...H3_TUNNEL_DEFAULTS, ...t }));
      }
      if (!config.h3.baseUrl) {
        config.h3.baseUrl = `http://localhost:${config.h3.tunnel.localPort}`;
      }
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
