import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir, readdir, rm, rename, unlink, stat } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, extname, basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { loadConfig, saveConfig, dataDir, getConfigDir, HEYGEM_TUNNEL_DEFAULTS, H3_TUNNEL_DEFAULTS, type AnalyticsSource, type HeygemTunnelConfig, type H3TunnelConfig, type LlmConfig, type LlmProviderConfig } from "../config.js";
import { PROVIDER_PRESETS } from "../llm/provider-keys.js";
import { getDb } from "../db/connection.js";
import { exportBackup, importBackup } from "../db/backup.js";
import { migrateLegacyWorks } from "../db/migrate-legacy.js";
import {
  listWorks, getWork, createWork,
  updateWork as storeUpdateWork, deleteWork as storeDeleteWork,
  listAssets, getAssetPath, saveStepHistory, loadStepHistory,
  saveWorkChat, saveEvalResult, loadAllEvalResults,
  deriveStatusFromPipeline,
  type Work, type PipelineStep, type EvalResult,
} from "../work-store.js";
import { MemoryClient } from "../memory.js";
import type { WsBridge } from "../ws-bridge.js";
import { resolveClaudeCommand } from "../ws-bridge.js";
import { getProvider, getDefaultProvider, listProviders } from "../providers/registry.js";
import { listSharedAssetsWithMeta, getSharedAssetPath, validateCategory, sanitizeFilename, saveSharedAsset, deleteSharedAsset, moveSharedAsset } from "../shared-assets.js";
import * as avatarsRepo from "../db/avatars-repo.js";
import * as dhJobsRepo from "../db/digital-human-jobs-repo.js";
import * as assetsRepo from "../db/assets-repo.js";
import {
  createAvatarFromUpload,
  setDefaultAvatar,
  submitJob,
  refreshJob,
  deleteJob,
  regenerateJob,
  isValidAvatarId,
} from "../services/digital-human.js";
import { getInstanceView } from "../services/instance-service.js";
import { getH3InstanceView } from "../services/h3-instance-service.js";
import { pushPublicKey } from "../services/ssh-key-service.js";
import { refineTemplate } from "../services/template-refine.js";
import { scoreTemplate } from "../services/template-score.js";
import { cloneTemplate, routeCloneUrl } from "../services/template-clone.js";
import type { TemplateElements } from "../services/template-dna.js";
import { researchTemplates } from "../services/template-research.js";
import { listSkills, deleteSkill } from "../db/template-skills-repo.js";
import {
  runDigitalHumanForWork,
  runBatchDigitalHuman,
  getBatchState,
  listPendingWorks,
  triggerRenderNow,
  getRenderPool,
  getPendingBoot,
  cancelQueuedJobsForWork,
  syncRenderPool,
} from "../services/digital-human-pipeline.js";
import {
  uploadAsset as uploadLibraryAsset,
  listAssets as listLibraryAssets,
  updateAsset as updateLibraryAsset,
  deleteAsset as deleteLibraryAsset,
  recheckCompliance,
} from "../services/asset-library.js";
import { syncStepConversation } from "../memory-sync.js";
import { enqueueWork, notifyWorkSettled } from "../services/work-queue.js";
import * as workQueueRepo from "../db/work-queue-repo.js";
import { log, readLogs } from "../logger.js";
import { runPipeline, getRunStatus, listRuns, getRunReport, type RunConfig } from "../test-runner.js";
import { evaluateWork } from "../test-evaluator.js";
import { collectTrends, listTopics, getTopic } from "../services/trend-research.js";
import { getAccount } from "../db/accounts-repo.js";
import { buildTonePrompt } from "../services/tone-profile.js";
import { updateTopic, deleteTopic } from "../db/topics-repo.js";
import * as worksRepo from "../db/works-repo.js";
import { createArticle, listArticlesByWork, updateArticle, listAllArticles } from "../db/articles-repo.js";
import { createScript, listScriptsByWork } from "../db/scripts-repo.js";
import { generateArticleFromTopic, generateScriptFromArticle } from "../services/content-generator.js";
import { randomUUID } from "node:crypto";
import { createTemplate, getTemplate, listTemplates, updateTemplate, deleteTemplate, sanitizeBranding, type DbTemplate } from "../db/templates-repo.js";
import { generateTemplates } from "../services/template-generator.js";
import { generateImageTextTemplates } from "../services/image-text-template-generator.js";
import { deriveDualOutputs } from "../services/dual-output.js";
import { createRenderJob, getRenderJob, listRenderJobs, updateRenderJob, type DbRenderJob } from "../db/render-jobs-repo.js";
import { startRender } from "../services/video-factory.js";
import { renderTimeline } from "../video/renderer.js";
import { escapeDrawtext, escapeFilterPath, lineHeightFor, normalizeColorForFfmpeg, resolveFontPaths, wrapTextLines } from "../video/draw-utils.js";
import { validateTemplate, TimelineValidationError } from "../video/schema.js";
import { applyVariables, fillDefaults } from "../video/variables.js";
import type { Timeline } from "../video/types.js";
import { publishRoutes } from "./publish-api.js";
import { publishWorkRoutes } from "./routes/publish.js";
import { accountsRoutes } from "./routes/accounts.js";
import { queueRoutes } from "./routes/queue.js";
import { calendarRoutes } from "./routes/calendar.js";
import { budgetRoutes } from "./routes/budget.js";
import { dataSourceRoutes } from "./routes/data-sources.js";
import { stockAssetRoutes } from "./routes/stock-assets.js";
import {
  listPublishRecords,
} from "../db/publish-records-repo.js";
import { listLatestWorkMetrics } from "../db/platform-metrics-repo.js";
import * as voicesRepo from "../db/voices-repo.js";
import {
  cloneVoiceFromUpload, generateVoiceDemo, generateBuiltinDemo,
  favoriteBuiltinVoice, deleteVoiceWithFiles,
  voicesDir, builtinDemoDir, isValidVoiceId, isSafeExternalVoiceId, builtinDemoFileName,
} from "../services/voice-clone.js";
import { listBuiltinVoices, BUILTIN_CATEGORIES } from "../services/builtin-voices.js";

export const apiRoutes = new Hono();

// Health check endpoint
apiRoutes.get("/api/health", (c) => c.json({ ok: true, version: "0.2.0" }));

// ── Python script runner for real-time trend data ────────────────────────────

const execFileAsync = promisify(execFile);

// 检测 GBK→UTF-8 mojibake:Windows shell + curl 传中文字面量时,中文 GBK 字节被 daemon
// 按 UTF-8 解析。Node 默认 fatal=false,非法序列被替换成 U+FFFD;宽松解码时也可能落到
// Latin Extended / Cyrillic 等区段。命中即拒,避免静默生成噪音 mp3。
function looksLikeMojibake(text: string): boolean {
  if (!text || text.length < 3) return false;
  let suspicious = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // U+FFFD:UTF-8 解码失败的替换字符,权重 2(这是 mojibake 最强信号)
    if (cp === 0xFFFD) { suspicious += 2; continue; }
    // Latin Extended-A/B/Additional
    if ((cp >= 0x0080 && cp <= 0x02AF) || (cp >= 0x1E00 && cp <= 0x1EFF)) { suspicious++; continue; }
    // Cyrillic / Greek / Armenian(GBK 字节流宽松解码常见误落点)
    if ((cp >= 0x0370 && cp <= 0x04FF) || (cp >= 0x0530 && cp <= 0x058F)) { suspicious++; continue; }
  }
  return suspicious / text.length > 0.3;
}

async function runTrendScript(platform: string): Promise<string> {
  const scriptsDir = join(process.cwd(), 'skills', 'trend-research', 'scripts');

  try {
    if (platform === 'douyin') {
      const { stdout } = await execFileAsync('python3', [
        join(scriptsDir, 'douyin_hot_search.py'), '--top', '30'
      ], { timeout: 30000 });
      return stdout;
    }
    // Other platforms via newsnow
    const { stdout } = await execFileAsync('python3', [
      join(scriptsDir, 'newsnow_trends.py'), platform, '--top', '20'
    ], { timeout: 30000 });
    return stdout;
  } catch (err) {
    console.error(`[trends] Script error for ${platform}:`, err);
    return '';
  }
}

// ── MIME type helper ────────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ── WsBridge accessor (set by server/index.ts after construction) ─────────
let wsBridge: WsBridge | null = null;

export function setWsBridge(bridge: WsBridge): void {
  wsBridge = bridge;
}

// ── Status & Config ─────────────────────────────────────────────────────────

// GET /api/status
apiRoutes.get("/api/status", async (c) => {
  const config = await loadConfig();
  return c.json({
    state: "idle",
    model: config.model,
    port: config.port,
  });
});

function flattenAnalytics(cfg: import("../config.js").Config) {
  return {
    analyticsEnabled: cfg.analytics.enabled,
    analyticsInterval: cfg.analytics.collectInterval,
    analyticsSourcesJson: JSON.stringify(cfg.analytics.sources),
  };
}

function parseAnalytics(body: Record<string, unknown>): import("../config.js").Config["analytics"] {
  const sources = (() => {
    try {
      const raw = body.analyticsSourcesJson;
      return raw ? (JSON.parse(String(raw)) as AnalyticsSource[]) : [];
    } catch {
      return [];
    }
  })();
  return {
    enabled: Boolean(body.analyticsEnabled),
    collectInterval: Math.max(5, Number(body.analyticsInterval) || 60),
    sources,
  };
}

// ── LLM 直连设置页(P1-T7,2026-08-17):apiKey 掩码/合并/连通性测试 ──

const LLM_KEY_MASK = "***";

/** apiKey 脱敏:前 6 + *** + 后 4;短 key 全掩码。前端凭 *** 识别"未改动" */
function maskApiKey(key: string | undefined): string {
  if (!key) return "";
  return key.length > 10 ? `${key.slice(0, 6)}${LLM_KEY_MASK}${key.slice(-4)}` : LLM_KEY_MASK;
}

/**
 * GET 呈现用:三家预设永远出现(未配置也给默认 baseUrl,设置页直接可填),
 * 用户自定义的额外 provider 原样保留;apiKey 一律掩码,绝不明文出接口。
 */
function presentLlm(llm: LlmConfig | undefined): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    const o = llm?.providers?.[key];
    providers[key] = {
      baseUrl: o?.baseUrl ?? preset.baseUrl,
      apiKey: maskApiKey(o?.apiKey),
      visionModel: o?.visionModel ?? preset.visionModel ?? "",
      enabled: o?.enabled !== false,
    };
  }
  for (const [key, o] of Object.entries(llm?.providers ?? {})) {
    if (!(key in providers)) {
      providers[key] = { ...o, apiKey: maskApiKey(o.apiKey), enabled: o.enabled !== false };
    }
  }
  return {
    defaultProvider: llm?.defaultProvider ?? "deepseek",
    models: llm?.models ?? {},
    providers,
  };
}

/**
 * PUT 合并:llm 段整组更新,但——
 * ① apiKey 含掩码标记 ***(设置页回显未改)时保留原值不覆盖;空串=显式清除
 * ② providers 未提及的 key 原样保留(预设三家之外的自定义 provider 不被整组更新误删)
 * ③ models/priceTable/guard 等其余字段未提交时保留(Phase 3 路由 UI 才接管)
 */
function mergeLlm(prev: LlmConfig | undefined, incoming: Partial<LlmConfig>): LlmConfig {
  const providers: Record<string, LlmProviderConfig> = { ...(prev?.providers ?? {}) };
  if (incoming.providers) {
    for (const [key, p] of Object.entries(incoming.providers)) {
      if (!p || typeof p !== "object") continue;
      const old = providers[key];
      providers[key] = {
        protocol: "openai",
        baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : (old?.baseUrl ?? ""),
        apiKey: typeof p.apiKey === "string"
          ? (p.apiKey.includes(LLM_KEY_MASK) ? (old?.apiKey ?? "") : p.apiKey)
          : (old?.apiKey ?? ""),
        visionModel: typeof p.visionModel === "string" ? (p.visionModel || undefined) : old?.visionModel,
        enabled: typeof p.enabled === "boolean" ? p.enabled : old?.enabled,
      };
    }
  }
  return {
    ...prev,
    ...(incoming.defaultProvider !== undefined ? { defaultProvider: incoming.defaultProvider } : {}),
    ...(incoming.models !== undefined ? { models: incoming.models } : {}),
    ...(incoming.priceTable !== undefined ? { priceTable: incoming.priceTable } : {}),
    ...(incoming.guard !== undefined ? { guard: incoming.guard } : {}),
    providers,
  };
}

// GET /api/config
apiRoutes.get("/api/config", async (c) => {
  const config = await loadConfig();
  return c.json({
    ...config,
    jimengAccessKey: config.jimeng?.accessKey ?? "",
    jimengSecretKey: config.jimeng?.secretKey ?? "",
    openrouterKey: config.openrouter?.apiKey ?? "",
    minimaxKey: config.minimax?.apiKey ?? "",
    digitalHumanBatchThreshold: config.digitalHuman?.batchThreshold ?? 3,
    zhihuDataSecret: config.zhihuData?.accessSecret ?? "",
    researchEnabled: config.research?.enabled ?? false,
    researchCron: config.research?.schedule ?? "0 9 * * *",
    researchTopN: config.research?.topN ?? 10,
    memorySyncEnabled: config.memory?.syncEnabled ?? false,
    heygemBaseUrl: config.heygem?.baseUrl ?? "",
    heygemApiToken: config.heygem?.apiToken ?? "",
    heygemGpuHourlyRateYuan: config.heygem?.gpuHourlyRateYuan ?? 1.78,
    heygemIdleReminderMinutes: config.heygem?.idleReminderMinutes ?? 15,
    heygemTunnelHost: config.heygem?.tunnel?.host ?? HEYGEM_TUNNEL_DEFAULTS.host,
    heygemTunnelPort: config.heygem?.tunnel?.port ?? HEYGEM_TUNNEL_DEFAULTS.port,
    // 多实例候选(tunnels 优先;无则由单数 tunnel 合成单候选,保持前端模型统一)
    heygemTunnels: config.heygem?.tunnels?.length
      ? config.heygem.tunnels
      : [{ ...HEYGEM_TUNNEL_DEFAULTS, ...(config.heygem?.tunnel ?? {}) }],
    // H3 本地视频生成:h3 段存在即启用
    h3Enabled: !!config.h3,
    h3Tunnels: config.h3?.tunnels?.length
      ? config.h3.tunnels
      : [{ ...H3_TUNNEL_DEFAULTS, ...(config.h3?.tunnel ?? {}) }],
    h3GpuHourlyRateYuan: config.h3?.gpuHourlyRateYuan ?? 2.18,
    h3IdleReminderMinutes: config.h3?.idleReminderMinutes ?? 30,
    pexelsApiKey: config.pexels?.apiKey ?? "",
    pixabayApiKey: config.pixabay?.apiKey ?? "",
    unsplashAccessKey: config.unsplash?.accessKey ?? "",
    // LLM 直连:覆盖 ...config 里的明文 llm 段,apiKey 掩码+预设补全(P1-T7)
    llm: presentLlm(config.llm),
    ...flattenAnalytics(config),
  });
});

// POST /api/llm/ping — 连通性测试(P1-T7):拉 models 列表,返回延迟;支持未保存的表单值直接测
apiRoutes.post("/api/llm/ping", async (c) => {
  const body = await c.req.json<{ provider?: string; baseUrl?: string; apiKey?: string }>().catch(() => ({} as { provider?: string; baseUrl?: string; apiKey?: string }));
  const key = body.provider ?? "deepseek";
  const config = await loadConfig();
  const saved = config.llm?.providers?.[key];
  const baseUrl = (body.baseUrl || saved?.baseUrl || PROVIDER_PRESETS[key]?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = body.apiKey && !body.apiKey.includes(LLM_KEY_MASK) ? body.apiKey : (saved?.apiKey ?? "");
  if (!baseUrl) return c.json({ ok: false, error: "未配置 baseUrl" }, 400);
  if (!apiKey) return c.json({ ok: false, error: "未配置 apiKey——请先填写或保存" }, 400);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return c.json({ ok: false, latencyMs, error: `HTTP ${res.status}: ${text}` });
    }
    const data = await res.json().catch(() => ({} as { data?: unknown[] }));
    return c.json({ ok: true, latencyMs, models: Array.isArray(data?.data) ? data.data.length : undefined });
  } catch (err) {
    return c.json({ ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
  }
});

/** 校验前端提交的隧道候选数组:逐条补默认值,丢弃缺 host/port 的无效行 */
function sanitizeTunnels<T extends { host: string; port: number }>(raw: unknown, defaults: T): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({ ...defaults, ...t }) as T)
    .filter((t) => typeof t.host === "string" && t.host.length > 0 && Number.isFinite(Number(t.port)) && Number(t.port) > 0)
    .map((t) => ({ ...t, port: Number(t.port) }));
}

// PUT /api/config
apiRoutes.put("/api/config", async (c) => {  const body = await c.req.json<Record<string, unknown>>();
  const config = await loadConfig();

  // Map flat frontend fields to nested config structure
  if (body.jimengAccessKey !== undefined) {
    if (!config.jimeng) config.jimeng = { accessKey: "", secretKey: "" };
    config.jimeng.accessKey = body.jimengAccessKey as string;
  }
  if (body.jimengSecretKey !== undefined) {
    if (!config.jimeng) config.jimeng = { accessKey: "", secretKey: "" };
    config.jimeng.secretKey = body.jimengSecretKey as string;
  }
  if (body.openrouterKey !== undefined) {
    config.openrouter = { apiKey: body.openrouterKey as string };
  }
  if (body.minimaxKey !== undefined) {
    // 保留 groupId 等其他 minimax 字段，避免保存 key 时被覆盖丢失
    config.minimax = { ...config.minimax, apiKey: body.minimaxKey as string };
  }
  if (body.digitalHumanBatchThreshold !== undefined) {
    // 渲染池攒批阈值：>=1 的整数，非法值回落默认 3
    const n = Math.floor(Number(body.digitalHumanBatchThreshold));
    config.digitalHuman = { ...config.digitalHuman, batchThreshold: Number.isFinite(n) && n > 0 ? n : 3 };
  }
  if (body.zhihuDataSecret !== undefined) {
    config.zhihuData = { ...config.zhihuData, accessSecret: body.zhihuDataSecret as string };
  }
  if (body.interests !== undefined) {
    // 关注领域：选题中心 updateConfig 走本接口，此前未映射导致保存被静默丢弃
    config.interests = Array.isArray(body.interests) ? body.interests.map(String) : [];
  }
  if (body.researchEnabled !== undefined) {
    if (!config.research) config.research = { enabled: false, schedule: "0 9 * * *", platforms: ["douyin", "xiaohongshu"] };
    config.research.enabled = body.researchEnabled as boolean;
  }
  if (body.researchCron !== undefined) {
    if (!config.research) config.research = { enabled: false, schedule: "0 9 * * *", platforms: ["douyin", "xiaohongshu"] };
    config.research.schedule = body.researchCron as string;
  }
  if (body.researchTopN !== undefined) {
    if (!config.research) config.research = { enabled: false, schedule: "0 9 * * *", platforms: ["douyin", "xiaohongshu"] };
    config.research.topN = Math.max(0, Number(body.researchTopN) || 0);
  }
  if (body.model !== undefined) {
    config.model = body.model as string;
  }
  if (body.memorySyncEnabled !== undefined) {
    if (!config.memory) config.memory = { apiKey: "", userId: "autoviral-user", syncEnabled: false };
    config.memory.syncEnabled = body.memorySyncEnabled as boolean;
  }

  if (body.heygemBaseUrl !== undefined || body.heygemApiToken !== undefined
    || body.heygemGpuHourlyRateYuan !== undefined || body.heygemIdleReminderMinutes !== undefined
    || body.heygemTunnelHost !== undefined || body.heygemTunnelPort !== undefined) {
    if (!config.heygem) config.heygem = { apiToken: "", baseUrl: "", gpuHourlyRateYuan: 1.78, idleReminderMinutes: 15 };
    if (body.heygemBaseUrl !== undefined) config.heygem.baseUrl = body.heygemBaseUrl as string;
    if (body.heygemApiToken !== undefined) config.heygem.apiToken = body.heygemApiToken as string;
    if (body.heygemGpuHourlyRateYuan !== undefined) config.heygem.gpuHourlyRateYuan = Number(body.heygemGpuHourlyRateYuan);
    if (body.heygemIdleReminderMinutes !== undefined) config.heygem.idleReminderMinutes = Number(body.heygemIdleReminderMinutes);
    if (body.heygemTunnelHost !== undefined || body.heygemTunnelPort !== undefined) {
      // 其余 tunnel 字段（user/localPort/remotePort）用默认值
      config.heygem.tunnel = { ...HEYGEM_TUNNEL_DEFAULTS, ...(config.heygem.tunnel ?? {}) };
      if (body.heygemTunnelHost !== undefined) config.heygem.tunnel.host = body.heygemTunnelHost as string;
      if (body.heygemTunnelPort !== undefined) config.heygem.tunnel.port = Number(body.heygemTunnelPort);
    }
  }
  // 多实例候选:前端传整组数组(host/port/user/localPort/remotePort),覆盖式更新
  if (body.heygemTunnels !== undefined) {
    if (!config.heygem) config.heygem = { apiToken: "", baseUrl: "", gpuHourlyRateYuan: 1.78, idleReminderMinutes: 15 };
    const list = sanitizeTunnels<HeygemTunnelConfig>(body.heygemTunnels, HEYGEM_TUNNEL_DEFAULTS);
    if (list.length > 0) {
      config.heygem.tunnels = list;
      delete config.heygem.tunnel;  // tunnels 优先,清掉单数避免歧义
    }
  }
  // H3 本地视频生成:h3Enabled=false 时删除 h3 段(provider 随之不注册)
  if (body.h3Enabled === false) {
    delete config.h3;
  } else if (body.h3Enabled === true || body.h3Tunnels !== undefined
    || body.h3GpuHourlyRateYuan !== undefined || body.h3IdleReminderMinutes !== undefined) {
    if (!config.h3) config.h3 = {};
    if (body.h3GpuHourlyRateYuan !== undefined) config.h3.gpuHourlyRateYuan = Number(body.h3GpuHourlyRateYuan);
    if (body.h3IdleReminderMinutes !== undefined) config.h3.idleReminderMinutes = Number(body.h3IdleReminderMinutes);
    if (body.h3Tunnels !== undefined) {
      const list = sanitizeTunnels<H3TunnelConfig>(body.h3Tunnels, H3_TUNNEL_DEFAULTS);
      if (list.length > 0) {
        config.h3.tunnels = list;
        delete config.h3.tunnel;
      }
    }
  }
  if (body.pexelsApiKey !== undefined) {
    if (!config.pexels) config.pexels = { apiKey: "" };
    config.pexels.apiKey = body.pexelsApiKey as string;
  }
  if (body.pixabayApiKey !== undefined) {
    if (!config.pixabay) config.pixabay = { apiKey: "" };
    config.pixabay.apiKey = body.pixabayApiKey as string;
  }
  if (body.unsplashAccessKey !== undefined) {
    if (!config.unsplash) config.unsplash = { accessKey: "" };
    config.unsplash.accessKey = body.unsplashAccessKey as string;
  }
  // LLM 直连段(设置页「大模型直连」):整组提交、掩码 key 保留原值,见 mergeLlm
  const llmChanged = body.llm !== undefined;
  if (llmChanged) {
    config.llm = mergeLlm(config.llm, (body.llm ?? {}) as Partial<LlmConfig>);
  }
  config.analytics = parseAnalytics(body);

  await saveConfig(config);
  if (llmChanged) {
    // provider 实例缓存了旧 baseUrl/apiKey,必须清缓存否则新配置要重启才生效
    const { _resetProviders } = await import("../llm/registry.js");
    _resetProviders();
  }
  // 调研开关/频率变更后立即重排 cron，无需重启服务
  if (body.researchEnabled !== undefined || body.researchCron !== undefined) {
    const { startTrendScheduler } = await import("../services/scheduler.js");
    startTrendScheduler().catch((err) => console.error("[scheduler] restart failed:", err));
  }
  // 字段级保存日志（脱敏，只记长度）——诊断"用户以为已保存但 key 为空"类问题
  log("info", "api", "config_saved", "-", {
    pexelsApiKey: (config.pexels?.apiKey ?? "").length,
    pixabayApiKey: (config.pixabay?.apiKey ?? "").length,
    unsplashAccessKey: (config.unsplash?.accessKey ?? "").length,
    minimaxKey: (config.minimax?.apiKey ?? "").length,
    heygemApiToken: (config.heygem?.apiToken ?? "").length,
    heygemBaseUrl: (config.heygem?.baseUrl ?? "").length,
  });
  // llm 段同样掩码返回,apiKey 明文不出接口(P1-T7)
  return c.json({ ...config, llm: presentLlm(config.llm) });
});

// ---------------------------------------------------------------------------
// Work API
// ---------------------------------------------------------------------------

// GET /api/works — list works with cover image and preview video
apiRoutes.get("/api/works", async (c) => {
  try {
    const works = await listWorks();
    // coverImage 用于卡片封面（图片优先，轻量）；
    // previewUrl 用于发布中心审核预览（成片视频优先，保证审核能看到视频）。
    // 此前预览复用封面逻辑导致"任意图片压制成片视频"、永远无法播放 —— 2026-07-21 Bug6。
    const toUrl = (workId: string, rel: string) =>
      `/api/works/${workId}/assets/${rel.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
    const isImage = (a: string) => /\.(png|jpe?g|webp|gif)$/i.test(a);
    const isVideo = (a: string) => /\.(mp4|mov|webm)$/i.test(a);
    const enriched = await Promise.all(works.map(async (w) => {
      try {
        const assets = await listAssets(w.id);
        // 成片视频：output/ 下文件名含 final 的优先，其次任意含 final 的视频
        const videos = assets.filter(isVideo);
        const finalVideo =
          videos.find((a: string) => a.startsWith("output/") && /final/i.test(a)) ??
          videos.find((a: string) => /final/i.test(a));
        const previewUrl = finalVideo ? toUrl(w.id, finalVideo) : undefined;

        // 封面：output 图片 → 任意图片 → 成片视频（前端渲染为 <video> 封面）
        const coverImageAsset =
          assets.find((a: string) => isImage(a) && a.startsWith("output/")) ??
          assets.find(isImage);
        if (coverImageAsset) {
          return { ...w, coverImage: toUrl(w.id, coverImageAsset), previewUrl };
        }
        if (finalVideo) {
          return { ...w, coverImage: toUrl(w.id, finalVideo), coverIsVideo: true, previewUrl };
        }
        return { ...w, previewUrl };
      } catch {}
      return w;
    }));
    return c.json({ works: enriched });
  } catch {
    return c.json({ works: [] });
  }
});

// POST /api/works
apiRoutes.post("/api/works", async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      type: string;
      contentCategory?: string;
      videoSource?: string;
      videoSearchQuery?: string;
      platforms: string[];
      topicHint?: string;
      templateId?: string;
      digitalHumanId?: string;
    }>();
    if (!body.title || !body.type || !body.platforms) {
      return c.json({ error: "title, type, and platforms are required" }, 400);
    }
    const work = await createWork({
      title: body.title,
      type: body.type as "short-video" | "image-text",
      contentCategory: body.contentCategory as any,
      videoSource: body.videoSource as any,
      videoSearchQuery: body.videoSearchQuery,
      platforms: body.platforms,
      topicHint: body.topicHint,
      templateId: body.templateId,
      digitalHumanId: body.digitalHumanId,
    });
    return c.json(work, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to create work" }, 400);
  }
});

// GET /api/works/:id
apiRoutes.get("/api/works/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const work = await getWork(id);
    if (!work) return c.json({ error: "Work not found" }, 404);
    return c.json(work);
  } catch {
    return c.json({ error: "Work not found" }, 404);
  }
});

// PUT /api/works/:id
apiRoutes.put("/api/works/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    const work = await storeUpdateWork(id, body);
    if (!work) return c.json({ error: "Work not found" }, 404);
    return c.json(work);
  } catch {
    return c.json({ error: "Work not found" }, 404);
  }
});

// DELETE /api/works/:id
// I4: 级联清理 —— 取消该作品未提交的渲染任务（防孤儿任务占用渲染池/重复计费）、
// 出队、删作品，最后同步渲染池顺序。
apiRoutes.delete("/api/works/:id", async (c) => {
  const id = c.req.param("id");
  try {
    cancelQueuedJobsForWork(id, "作品已删除，渲染取消");
    workQueueRepo.removeItem(id);
    const deleted = await storeDeleteWork(id);
    if (!deleted) return c.json({ error: "Work not found" }, 404);
    syncRenderPool();
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "Work not found" }, 404);
  }
});

// POST /api/works/:id/reject — 发布中心"打回修改"。
// 与历史上的"PUT 状态置 assembling"不同，本端点真正驱动重做：
// 1) 持久化审核意见（works.review_comment）；
// 2) 流水线重置：目标阶段 → active，其后阶段 → pending，之前阶段 → done；
// 3) works.status 跟随流水线派生（planning/assetting/assembling），不再滞留待审核列表；
// 4) 作品入队（排在 running 之后），由串行 runner 重建会话 —— 审核意见已入库，
//    runner 调 startWorkSession 时会随 prompt 自动注入，无需在此直接驱动会话。
apiRoutes.post("/api/works/:id/reject", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{ stage?: string; comment?: string }>().catch(() => ({} as any));
    const stage = body.stage;
    const comment = (body.comment ?? "").trim();
    if (!stage || !comment) return c.json({ error: "stage and comment are required" }, 400);

    let work = await getWork(id);
    if (!work) return c.json({ error: "Work not found" }, 404);

    // 图文子作品(无流水线)打回 → 转发父作品:图文内容源自父作品策划阶段,
    // 父作品重做后 deriveDualOutputs 会刷新仍在 reviewing 的子作品
    // (2026-08-07 双产物子作品机制)。已 approved/published 的子作品不被刷新。
    if (work.parentWorkId) {
      const parent = await getWork(work.parentWorkId);
      if (!parent) return c.json({ error: "父作品不存在，无法打回重做" }, 400);
      log("info", "api", "work_rejected_via_child", id, { parentId: parent.id, stage });
      work = parent;
    }
    const targetId = work.id;

    const stepKeys = Object.keys(work.pipeline);
    if (!stepKeys.includes(stage)) {
      return c.json({ error: `Unknown stage: ${stage}. Available: ${stepKeys.join(", ")}` }, 400);
    }

    // 1. 重置流水线
    const stageIdx = stepKeys.indexOf(stage);
    const now = new Date().toISOString();
    for (let i = 0; i < stepKeys.length; i++) {
      const key = stepKeys[i];
      if (i < stageIdx) {
        if (work.pipeline[key].status !== "done" && work.pipeline[key].status !== "skipped") {
          work.pipeline[key].status = "done";
          work.pipeline[key].completedAt = work.pipeline[key].completedAt ?? now;
        }
      } else if (i === stageIdx) {
        work.pipeline[key] = { ...work.pipeline[key], status: "active", startedAt: now, completedAt: undefined };
      } else {
        work.pipeline[key] = { ...work.pipeline[key], status: "pending", startedAt: undefined, completedAt: undefined };
      }
    }

    // 2. 意见入库 + 状态派生
    const newStatus = deriveStatusFromPipeline(work.pipeline, work.status);
    await storeUpdateWork(targetId, { pipeline: work.pipeline, status: newStatus, reviewComment: comment });
    broadcastPipelineUpdate(targetId, work.pipeline);
    log("info", "api", "work_rejected", targetId, { stage, status: newStatus });

    // 3. 渲染池清理：取消该作品未提交的旧渲染任务（重做会重新合成口播，
    //    旧任务留着会被攒批提交 → 复用旧口播/重复计费）
    const cancelled = cancelQueuedJobsForWork(targetId);
    if (cancelled > 0) log("info", "api", "render_jobs_cancelled", targetId, { cancelled });

    // 4. 入队等待串行 runner 驱动重做（afterRunning：排在当前运行中作品之后、
    // 其余排队作品之前）。即使该作品此刻有活跃会话也不直接 sendMessage ——
    // 会话跑完当前阶段后自然停滞，runner 健康检查会重建会话并注入审核意见。
    enqueueWork(targetId, { afterRunning: true });
    // 入队位置变化后同步渲染池位次
    syncRenderPool();

    return c.json({ ok: true, status: newStatus, pipeline: work.pipeline, delivery: "queued" });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Reject error" }, 500);
  }
});

// GET /api/works/:id/assets
apiRoutes.get("/api/works/:id/assets", async (c) => {
  const id = c.req.param("id");
  try {
    const assets = await listAssets(id);
    return c.json({ assets });
  } catch {
    return c.json({ assets: [] });
  }
});

// GET /api/works/:id/assets/* — serve asset files (supports nested paths like images/scene-01.png or output/final.mp4)
apiRoutes.get("/api/works/:id/assets/*", async (c) => {
  const id = c.req.param("id");
  // Extract the nested path after /assets/
  const url = new URL(c.req.url);
  const prefix = `/api/works/${id}/assets/`;
  const nestedPath = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\\/g, "/");
  if (!nestedPath) return c.json({ error: "Asset path required" }, 400);

  try {
    // nestedPath maps directly to workspace subdirectory (e.g. "images/xxx.png", "output/xxx.png")
    // 兼容两种磁盘布局:老结构 workDir/clips/x.mp4 直命中;
    // 现行结构 workDir/assets/clips/x.mp4(provider 产物都写在 assets/ 下)需回退拼接
    const { stat } = await import("node:fs/promises");
    let filePath = getAssetPath(id, nestedPath);
    try {
      await stat(filePath);
    } catch {
      filePath = getAssetPath(id, `assets/${nestedPath}`);
    }
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const mimeType = getMimeType(filePath);
    const rangeHeader = c.req.header("range");

    // Support HTTP Range requests (required for browser video/audio playback)
    if (rangeHeader && (mimeType.startsWith("video/") || mimeType.startsWith("audio/"))) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const fullContent = await readFile(filePath);
        const slice = fullContent.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": mimeType,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": String(chunkSize),
            "Accept-Ranges": "bytes",
          },
        });
      }
    }

    const content = await readFile(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      },
    });
  } catch {
    return c.json({ error: "Asset not found" }, 404);
  }
});

// GET /api/works/:id/articles — PRD: list articles for a work
apiRoutes.get("/api/works/:id/articles", async (c) => {
  const id = c.req.param("id");
  const articles = listArticlesByWork(id);
  return c.json({ articles });
});

// GET /api/articles - list all articles
apiRoutes.get("/api/articles", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const articles = listAllArticles(limit);
  return c.json({ articles });
});

// GET /api/articles/:id - get a single article
apiRoutes.get("/api/articles/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const { getArticle } = await import("../db/articles-repo.js");
  const article = getArticle(id);
  if (!article) return c.json({ error: "Article not found" }, 404);
  return c.json(article);
});

// PUT /api/articles/:id - update an article (edit + save)
apiRoutes.put("/api/articles/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json<{ title?: string; content?: string; platform?: string; status?: string }>();
  const updated = updateArticle(id, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.platform !== undefined ? { platform: body.platform } : {}),
    ...(body.status !== undefined ? { status: body.status as any } : {}),
  });
  if (!updated) return c.json({ error: "Article not found" }, 404);
  return c.json(updated);
});

// GET /api/works/:id/scripts — PRD: list scripts for a work
apiRoutes.get("/api/works/:id/scripts", async (c) => {
  const id = c.req.param("id");
  const scripts = listScriptsByWork(id);
  return c.json({ scripts });
});

// POST /api/works/:id/assets/upload — upload file to work assets
apiRoutes.post("/api/works/:id/assets/upload", async (c) => {
  const workId = c.req.param("id");
  const body = await c.req.parseBody();
  const file = body.file;
  const subdir = (body.subdir as string) ?? "images";

  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  const assetsDir = join(homedir(), ".autoviral", "works", workId, "assets", subdir);
  await mkdir(assetsDir, { recursive: true });
  const filePath = join(assetsDir, file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filePath, buffer);

  return c.json({
    success: true,
    path: `${subdir}/${file.name}`,
    url: `/api/works/${workId}/assets/${subdir}/${encodeURIComponent(file.name)}`,
  });
});

// GET /api/analytics — aggregate metrics from all works
apiRoutes.get("/api/analytics", (c) => {
  try {
    const records = listPublishRecords();
    const latestMetrics = listLatestWorkMetrics();
    const totalViews = latestMetrics.reduce((s, m) => s + (m.views ?? 0), 0);
    const totalLikes = latestMetrics.reduce((s, m) => s + (m.likes ?? 0), 0);

    return c.json({
      totalRecords: records.length,
      totalViews,
      totalLikes,
      platforms: Array.from(new Set(records.map((r) => r.platform))),
    });
  } catch {
    return c.json({ totalRecords: 0, totalViews: 0, totalLikes: 0, platforms: [] });
  }
});

// ---------------------------------------------------------------------------
// Generate API (Provider-based image/video generation)
// ---------------------------------------------------------------------------

// POST /api/generate/image
apiRoutes.post("/api/generate/image", async (c) => {
  const body = await c.req.json();
  const { workId, prompt, width, height, filename, provider: providerName, referenceImage,
    aspectRatio, imageSize, seed, temperature, model } = body;
  if (!workId || !prompt || !filename) {
    return c.json({ success: false, error: "Missing required fields", code: "INVALID_PARAMS" }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("image");
  if (!provider) {
    return c.json({ success: false, error: "No image provider available", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.generateImage({
      prompt, width, height, workId, filename, referenceImage,
      aspectRatio, imageSize, seed, temperature, model,
    });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// POST /api/generate/video
apiRoutes.post("/api/generate/video", async (c) => {
  const body = await c.req.json();
  const { workId, prompt, firstFrame, lastFrame, resolution, filename, provider: providerName,
    referenceImages, referenceVideos, ratio, durationHint, language, duration, modelVersion, shotType } = body;
  if (!workId || !prompt || !filename) {
    return c.json({ success: false, error: "Missing required fields", code: "INVALID_PARAMS" }, 400);
  }
  if (looksLikeMojibake(prompt)) {
    return c.json({
      success: false,
      error: "prompt 字符序列疑似 GBK→UTF-8 mojibake(常见于 Windows shell + curl 传中文字面量)。请改用脚本文件或 python/node 发请求,并在 header 加 'Content-Type: application/json; charset=utf-8'。",
      code: "INVALID_PARAMS",
    }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("video");
  if (!provider) {
    return c.json({ success: false, error: "No video provider available", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.generateVideo({
      prompt, firstFrame, lastFrame, resolution, workId, filename,
      referenceImages, referenceVideos, ratio, durationHint, language, duration, modelVersion, shotType,
    });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// POST /api/generate/audio
apiRoutes.post("/api/generate/audio", async (c) => {
  const body = await c.req.json();
  const { workId, text, voice, speed, languageBoost, filename, provider: providerName } = body;
  if (!workId || !text || !filename) {
    return c.json({ success: false, error: "Missing required fields: workId, text, filename", code: "INVALID_PARAMS" }, 400);
  }
  if (looksLikeMojibake(text)) {
    return c.json({
      success: false,
      error: "text 字符序列疑似 GBK→UTF-8 mojibake(常见于 Windows shell + curl 传中文字面量)。请用 narration_generate.py 脚本或在请求 header 加 'Content-Type: application/json; charset=utf-8' 并用 fetch/requests。",
      code: "INVALID_PARAMS",
    }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("audio");
  if (!provider || !provider.supportsAudio || !provider.generateAudio) {
    return c.json({ success: false, error: "No audio provider available", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.generateAudio({ text, voice, speed, languageBoost, workId, filename });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// POST /api/generate/music — BGM 配乐 / 带歌词歌曲（MiniMax music_generation）
apiRoutes.post("/api/generate/music", async (c) => {
  const body = await c.req.json();
  const { workId, prompt, lyrics, duration, filename, provider: providerName } = body;
  if (!workId || !prompt || !filename) {
    return c.json({ success: false, error: "Missing required fields: workId, prompt, filename", code: "INVALID_PARAMS" }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("music");
  if (!provider || !provider.supportsMusic || !provider.generateMusic) {
    return c.json({ success: false, error: "No music provider available — check MINIMAX_API_KEY", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.generateMusic({ prompt, lyrics, duration, workId, filename });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// POST /api/edit/inpaint — 局部重绘 / 消除笔(原图 + mask 双图输入)
apiRoutes.post("/api/edit/inpaint", async (c) => {
  const body = await c.req.json();
  const { workId, prompt, originalImage, maskImage, seed, filename, provider: providerName } = body;
  if (!workId || !prompt || !originalImage || !maskImage || !filename) {
    return c.json({ success: false, error: "Missing required fields: workId, prompt, originalImage, maskImage, filename", code: "INVALID_PARAMS" }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("image");
  if (!provider || !provider.supportsImageEdit || !provider.editImage) {
    return c.json({ success: false, error: "No image-edit provider available", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.editImage({ prompt, originalImage, maskImage, seed, workId, filename });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// POST /api/edit/upscale — 智能超清(单图 4K/8K 升清)
apiRoutes.post("/api/edit/upscale", async (c) => {
  const body = await c.req.json();
  const { workId, originalImage, resolution, scale, filename, provider: providerName } = body;
  if (!workId || !originalImage || !filename) {
    return c.json({ success: false, error: "Missing required fields: workId, originalImage, filename", code: "INVALID_PARAMS" }, 400);
  }
  const provider = providerName ? getProvider(providerName) : getDefaultProvider("image");
  if (!provider || !provider.supportsImageUpscale || !provider.upscaleImage) {
    return c.json({ success: false, error: "No image-upscale provider available", code: "INVALID_PARAMS" }, 400);
  }
  try {
    const result = await provider.upscaleImage({ originalImage, resolution, scale, workId, filename });
    return c.json(result);
  } catch (err: any) {
    return c.json({ success: false, error: err.message, code: "API_ERROR" }, 500);
  }
});

// GET /api/generate/providers
apiRoutes.get("/api/generate/providers", (c) => c.json(listProviders()));

// ---------------------------------------------------------------------------
// Shared Assets
// ---------------------------------------------------------------------------

apiRoutes.get("/api/shared-assets", async (c) => {
  const assets = await listSharedAssetsWithMeta();
  return c.json(assets);
});

// GET /api/shared-assets/charts/:file - serve rendered chart PNGs (A1 数据图表素材)
apiRoutes.get("/api/shared-assets/charts/:file", async (c) => {
  const file = c.req.param("file");
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return c.json({ error: "Invalid filename" }, 400);
  try {
    const filePath = join(dataDir, "shared-assets", "charts", file);
    const data = await readFile(filePath);
    return new Response(data, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
    });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    return c.json({ error: "Failed to read file" }, 500);
  }
});

// POST /api/assets/chart - ECharts option → 图表 PNG(A1 数据图表素材,2026-08-14)
apiRoutes.post("/api/assets/chart", async (c) => {
  const body = await c.req.json<{
    option?: Record<string, unknown>;
    theme?: string; width?: number; height?: number; scale?: number;
    title?: string; source?: string;
  }>().catch(() => ({}) as { option?: Record<string, unknown>; theme?: string; width?: number; height?: number; scale?: number; title?: string; source?: string });
  if (!body.option) return c.json({ error: "option is required (ECharts option JSON)" }, 400);
  try {
    const { renderChart } = await import("../services/chart-render.js");
    const result = await renderChart({
      option: body.option,
      theme: body.theme, width: body.width, height: body.height, scale: body.scale,
      title: body.title, source: body.source,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "图表渲染失败" }, 400);
  }
});

// GET /api/assets/chart/themes - 图表主题列表
apiRoutes.get("/api/assets/chart/themes", async (c) => {
  const { CHART_THEMES } = await import("../services/chart-render.js");
  return c.json({ themes: CHART_THEMES.map((t) => ({ key: t.key, label: t.label, background: t.background, palette: t.palette })) });
});

// GET /api/shared-assets/snapshots/:file - serve snapshot card PNGs (A2 快照卡素材)
apiRoutes.get("/api/shared-assets/snapshots/:file", async (c) => {
  const file = c.req.param("file");
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return c.json({ error: "Invalid filename" }, 400);
  try {
    const data = await readFile(join(dataDir, "shared-assets", "snapshots", file));
    return new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    return c.json({ error: "Failed to read file" }, 500);
  }
});

// POST /api/assets/snapshot-card - 网页/图片 → 高亮标注快照卡(A2,2026-08-14)
apiRoutes.post("/api/assets/snapshot-card", async (c) => {
  const body = await c.req.json<{
    url?: string; imagePath?: string;
    highlights?: Array<{ left: number; top: number; width: number; height: number; color?: string; label?: string }>;
    title?: string; source?: string; width?: number; height?: number; style?: "dark" | "light";
  }>().catch(() => ({}) as any);
  if (!body.url && !body.imagePath) return c.json({ error: "url 或 imagePath 必须提供一个" }, 400);
  try {
    const { renderSnapshotCard } = await import("../services/snapshot-card.js");
    const result = await renderSnapshotCard(body);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "快照卡渲染失败" }, 400);
  }
});

// GET /api/assets/icons/search?q= - 图标搜索(A3,2026-08-14)
apiRoutes.get("/api/assets/icons/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim()) return c.json({ error: "q is required" }, 400);
  const { searchIcons } = await import("../services/icon-service.js");
  return c.json({ icons: searchIcons(q.trim()) });
});

// GET /api/assets/icons/sets - 图标集清单
apiRoutes.get("/api/assets/icons/sets", async (c) => {
  const { listIconSets } = await import("../services/icon-service.js");
  return c.json({ sets: listIconSets() });
});

// GET /api/assets/icons/:set/:name?name.svg&color=&size= - 图标 SVG 直出
apiRoutes.get("/api/assets/icons/:set/:name", async (c) => {
  const set = c.req.param("set");
  const name = (c.req.param("name") ?? "").replace(/\.svg$/i, "");
  const { getIconSvg } = await import("../services/icon-service.js");
  const svg = getIconSvg(set, name, {
    color: c.req.query("color"),
    size: c.req.query("size") ? Number(c.req.query("size")) : undefined,
  });
  if (!svg) return c.json({ error: "Icon not found" }, 404);
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
});

// POST /api/assets/data-card - 结构化数据 → 图表 PNG(B4,2026-08-14)
// 便捷封装:传 [{label,value}] 即可,不用手写 ECharts option
apiRoutes.post("/api/assets/data-card", async (c) => {
  const body = await c.req.json<{
    data?: Array<{ label: string; value: number }>;
    chartType?: "auto" | "bar" | "line" | "pie";
    title?: string; source?: string; unit?: string; theme?: string;
    width?: number; height?: number;
  }>().catch(() => ({}) as any);
  if (!body.data) return c.json({ error: "data is required: [{label, value}, ...]" }, 400);
  try {
    const { renderDataCard } = await import("../services/data-card.js");
    return c.json(await renderDataCard(body));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "数据卡渲染失败" }, 400);
  }
});

// POST /api/assets/code-scene - 程序化动画场景(A3 代码渲染素材,2026-08-14)
// 结构图/流程图/逻辑链条镜头:模板参数化渲染 mp4 段,替代静态图兜底
apiRoutes.post("/api/assets/code-scene", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, error: "invalid JSON body" }, 400);
  const { renderCodeScene, validateCodeSceneInput } = await import("../services/code-scene.js");
  const errors = validateCodeSceneInput(body);
  if (errors.length) return c.json({ success: false, error: errors.join("; "), code: "INVALID_PARAMS" }, 400);
  const result = await renderCodeScene(body);
  return c.json(result, result.success ? 200 : 500);
});

// GET /api/assets/code-scene/templates - 可用场景模板清单(agent 发现入口)
apiRoutes.get("/api/assets/code-scene/templates", (c) => {
  return c.json({
    templates: [
      { name: "structure-growth", label: "中心辐射结构图", params: "title, center, branches[2-4]{text,label,color?}", bestFor: "中心-分支结构(资金闭环/三段论)" },
      { name: "flow-steps", label: "流程步骤推进", params: "title, steps[2-5]{title,desc?}", bestFor: "流程/标准/步骤(退出三标准)" },
      { name: "logic-chain", label: "逻辑链条递进", params: "title, chain[2-4]string", bestFor: "因果/递进链条(政策→影响→应对)" },
    ],
    themes: ["finance_dark", "warm_gold", "ink_green", "minimal_light"],
    duration: "1-30s,建议 4-8s",
    note: "精确数据镜头仍走 /api/assets/chart|data-card;本端点服务结构/流程/逻辑镜头;模板按 1080x1920 竖版设计,非默认尺寸可能导致布局错位",
  });
});

// GET /api/assets/library - 素材资产库检索(C5,2026-08-14):q 模糊匹配名称/标签,按使用频次优先
apiRoutes.get("/api/assets/library", async (c) => {
  const type = c.req.query("type");
  const q = c.req.query("q")?.toLowerCase();
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
  let assets = assetsRepo.listAssets({ type: type as any, limit: 500 });
  if (q) {
    assets = assets.filter((a) =>
      a.name.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  // 使用频次高的=验证过的,优先推荐
  assets.sort((a, b) => b.usage_count - a.usage_count || b.updated_at.localeCompare(a.updated_at));
  return c.json({ assets: assets.slice(0, limit) });
});

// GET /api/works/:id/quality - 出片质量门禁报告(2026-08-14 精品化)
apiRoutes.get("/api/works/:id/quality", async (c) => {
  const workId = c.req.param("id");
  const reportPath = join(dataDir, "works", workId, "output", "quality-report.json");
  if (existsSync(reportPath)) {
    try {
      return c.json(JSON.parse(await readFile(reportPath, "utf-8")));
    } catch { /* 报告损坏时重新跑 */ }
  }
  // 报告不存在(旧作品)→ 找到成片现场跑一次。
  // 2026-08-16 修正：优先精确匹配 final.mp4（真成片）——原逻辑只找 *_final.mp4，
  // 会把 job_<id>_final.mp4 模板分段当成果片，QC 报告打在 8s 分段上（f2c/d34 连踩）
  const outDir = join(dataDir, "works", workId, "output");
  const entries = existsSync(outDir) ? await readdir(outDir) : [];
  const exactFinal = entries.find((f) => /^final\.(mp4|mov|webm)$/i.test(f));
  const segments = entries.filter((f) => f.endsWith("_final.mp4"));
  if (!exactFinal && segments.length === 0) return c.json({ error: "无成片可检查" }, 404);
  let target = exactFinal;
  if (!target) {
    const withMtime = await Promise.all(segments.map(async (f) => ({ f, m: (await stat(join(outDir, f))).mtimeMs })));
    withMtime.sort((a, b) => b.m - a.m);
    target = withMtime[0].f;
  }
  const { runQualityGate } = await import("../services/quality-gate.js");
  const report = await runQualityGate(join(outDir, target));
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8").catch(() => {});
  return c.json(report);
});

// GET /api/shared-assets/templates/:id/:file - serve template-specific assets (poster.png, preview.mp4)
apiRoutes.get("/api/shared-assets/templates/:id/:file", async (c) => {
  const id = c.req.param("id");
  const file = c.req.param("file");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return c.json({ error: "Invalid template id" }, 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return c.json({ error: "Invalid filename" }, 400);
  try {
    const filePath = join(TEMPLATE_DIR, id, file);
    const data = await readFile(filePath);
    const ext = extname(file).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp",
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    };
    const mime = mimeMap[ext] ?? "application/octet-stream";
    return new Response(data, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(data.length),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    return c.json({ error: "Failed to read file" }, 500);
  }
});

apiRoutes.get("/api/shared-assets/:category/:file", async (c) => {
  const category = c.req.param("category");
  const file = c.req.param("file");
  try {
    validateCategory(category);
    const filePath = getSharedAssetPath(category, file);
    const data = await readFile(filePath);
    const mime = getMimeType(filePath);
    const isMedia = mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/");
    const baseHeaders: Record<string, string> = {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": isMedia ? "inline" : `attachment; filename="${encodeURIComponent(sanitizeFilename(file))}"`,
    };
    // HTTP Range 支持：视频/音频预览可拖动进度条、分段加载（否则浏览器需整文件下载）
    const range = c.req.header("range");
    if (isMedia && range) {
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (match && (match[1] || match[2])) {
        const total = data.length;
        const start = match[1] ? parseInt(match[1], 10) : Math.max(0, total - parseInt(match[2], 10));
        const end = match[1] && match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        if (start >= total || start > end) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
        }
        return new Response(data.subarray(start, end + 1), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(end - start + 1),
          },
        });
      }
    }
    return new Response(data, {
      headers: {
        ...baseHeaders,
        ...(isMedia ? { "Accept-Ranges": "bytes" } : {}),
        "Content-Length": String(data.length),
      },
    });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    if (e.message?.includes("Invalid")) return c.json({ error: e.message }, 400);
    return c.json({ error: "Failed to read file" }, 500);
  }
});

apiRoutes.post("/api/shared-assets/move", async (c) => {
  try {
    const { from, to, file } = await c.req.json<{ from: string; to: string; file: string }>();
    if (!from || !to || !file) return c.json({ error: "from, to, and file are required" }, 400);
    await moveSharedAsset(from, to, file);
    return c.json({ moved: true, from, to, file });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    if (e.message?.includes("Invalid")) return c.json({ error: e.message }, 400);
    if (e.message?.includes("already exists")) return c.json({ error: e.message }, 409);
    return c.json({ error: e.message ?? "Move failed" }, 500);
  }
});

apiRoutes.post("/api/shared-assets/:category", async (c) => {
  const category = c.req.param("category");
  try {
    validateCategory(category);
  } catch {
    return c.json({ error: `Invalid category: ${category}` }, 400);
  }
  try {
    const body = await c.req.parseBody({ all: true });
    const files = Array.isArray(body["file"]) ? body["file"] : body["file"] ? [body["file"]] : [];
    const uploaded = [];
    for (const f of files) {
      if (!(f instanceof File)) continue;
      if (f.size > 100 * 1024 * 1024) return c.json({ error: `File ${f.name} exceeds 100MB limit` }, 400);
      const buf = Buffer.from(await f.arrayBuffer());
      const asset = await saveSharedAsset(category, f.name, buf);
      uploaded.push({ ...asset, url: `/api/shared-assets/${category}/${encodeURIComponent(asset.name)}` });
    }
    if (uploaded.length === 0) return c.json({ error: "No files provided" }, 400);
    return c.json({ uploaded });
  } catch (e: any) {
    return c.json({ error: e.message ?? "Upload failed" }, 500);
  }
});

apiRoutes.delete("/api/shared-assets/:category/:file", async (c) => {
  const category = c.req.param("category");
  const file = c.req.param("file");
  try {
    await deleteSharedAsset(category, file);
    return c.json({ deleted: true });
  } catch (e: any) {
    if (e.code === "ENOENT") return c.json({ error: "File not found" }, 404);
    if (e.message?.includes("Invalid")) return c.json({ error: e.message }, 400);
    return c.json({ error: "Delete failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Voices（声音克隆 / 配音音色库）
// ---------------------------------------------------------------------------

apiRoutes.get("/api/voices", async (c) => {
  return c.json({ voices: voicesRepo.listVoices() });
});

apiRoutes.get("/api/voices/builtin", async (c) => {
  const voices = await listBuiltinVoices();
  return c.json({ voices, categories: [...BUILTIN_CATEGORIES] });
});

// POST /api/voices/clone — 上传样本克隆真人声音（multipart: name, file）
apiRoutes.post("/api/voices/clone", async (c) => {
  try {
    const body = await c.req.parseBody();
    const name = (body.name as string) || "";
    const file = body.file as File | undefined;
    if (!file) return c.json({ error: "file is required" }, 400);
    if (!name.trim()) return c.json({ error: "name is required" }, 400);
    const buffer = Buffer.from(await file.arrayBuffer());
    const voice = await cloneVoiceFromUpload(name, buffer, file.name);
    return c.json(voice, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "克隆失败";
    if (message.includes("不支持的音频格式") || message.includes("20MB")) {
      return c.json({ error: message }, 400);
    }
    return c.json({ error: message }, 500);
  }
});

// POST /api/voices/:id/demo — 生成/复用试听
apiRoutes.post("/api/voices/:id/demo", async (c) => {
  const id = c.req.param("id");
  if (!isValidVoiceId(id)) return c.json({ error: "Invalid id" }, 400);
  try {
    const body = await c.req.json().catch(() => ({}));
    await generateVoiceDemo(id, (body as any).text);
    return c.json({ url: `/api/voices/${id}/demo.mp3?t=${Date.now()}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "试听生成失败";
    return c.json({ error: message }, message.includes("不存在") ? 404 : 500);
  }
});

apiRoutes.get("/api/voices/:id/demo.mp3", async (c) => {
  const id = c.req.param("id");
  if (!isValidVoiceId(id)) return c.json({ error: "Invalid id" }, 400);
  try {
    const data = await readFile(join(voicesDir(id), "demo.mp3"));
    return new Response(data, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=3600" } });
  } catch {
    return c.json({ error: "Demo not found" }, 404);
  }
});

// POST /api/voices/builtin-demo — 内置音色试听
apiRoutes.post("/api/voices/builtin-demo", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const { voiceId, text } = body as { voiceId?: string; text?: string };
  if (!voiceId || !isSafeExternalVoiceId(voiceId)) return c.json({ error: "voiceId is required" }, 400);
  try {
    await generateBuiltinDemo(voiceId, text);
    return c.json({ url: `/api/voices/builtin-demos/${builtinDemoFileName(voiceId)}?t=${Date.now()}` });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "试听生成失败" }, 500);
  }
});

apiRoutes.get("/api/voices/builtin-demos/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[a-zA-Z0-9_-]+\.mp3$/.test(filename)) return c.json({ error: "Invalid filename" }, 400);
  try {
    const data = await readFile(join(builtinDemoDir(), filename));
    return new Response(data, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.json({ error: "Demo not found" }, 404);
  }
});

// POST /api/voices/favorite — 收藏内置音色
apiRoutes.post("/api/voices/favorite", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const { voiceId, name, metadata } = body as { voiceId?: string; name?: string; metadata?: Record<string, unknown> };
  if (!voiceId || !name) return c.json({ error: "voiceId and name are required" }, 400);
  if (!isSafeExternalVoiceId(voiceId)) return c.json({ error: "Invalid voiceId" }, 400);
  const voice = await favoriteBuiltinVoice(voiceId, name, metadata ?? {});
  return c.json(voice, 201);
});

apiRoutes.delete("/api/voices/:id", async (c) => {
  const id = c.req.param("id");
  if (!isValidVoiceId(id)) return c.json({ error: "Voice not found" }, 404);
  const ok = await deleteVoiceWithFiles(id);
  if (!ok) return c.json({ error: "Voice not found" }, 404);
  return c.json({ deleted: true });
});

// GET /api/interests — 获取用户兴趣列表
apiRoutes.get("/api/interests", async (c) => {
  const config = await loadConfig();
  return c.json({ interests: config.interests ?? [] });
});

// PUT /api/interests — 更新用户兴趣列表
apiRoutes.put("/api/interests", async (c) => {
  try {
    const body = await c.req.json<{ interests: string[] }>();
    const current = await loadConfig();
    const interests = body.interests ?? [];
    await saveConfig({ ...current, interests });
    return c.json({ success: true, interests });
  } catch (err) {
    return c.json({ error: "Failed to save interests" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Trend Research via Claude CLI
// ---------------------------------------------------------------------------

/** Run claude CLI with a prompt and return the text result. */
function runCliBrief(prompt: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--model", "haiku",
    ];

    const cliCmd = resolveClaudeCommand();
    const proc = spawn(cliCmd, args, {
      cwd: homedir(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    });

    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("exit", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`CLI exited with code ${code}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        resolve(envelope.result ?? "");
      } catch {
        resolve(stdout);
      }
    });
    proc.on("error", reject);
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("Timeout")); }, timeoutMs);
  });
}

async function researchTrends(platforms: string[]): Promise<{ collected: string[]; errors: string[] }> {
  const collected: string[] = [];
  const errors: string[] = [];

  // Load user interests once for all platforms
  const config = await loadConfig();
  const interests = config.interests ?? [];
  // BUGFIX: user interests are the PRIMARY driver, not a soft suggestion
  const interestClause = interests.length > 0
    ? [
        ``,
        `## 用户关注领域（核心驱动 - 最高优先级）`,
        ``,
        `用户指定了以下关注领域：**${interests.join("、")}**`,
        ``,
        `**强制规则：**`,
        `1. **100% 的推荐话题必须直接属于用户关注的领域或其紧密相关子领域。禁止返回任何与关注领域无关的泛热门话题。**`,
        `2. 每个关注领域至少覆盖 2-3 个话题。如果一个领域太大（如"科技"），请拆分为具体子方向`,
        `3. 如果某个关注领域在当前平台热搜中完全没有相关条目，请用 WebSearch 深度搜索该领域`,
          `4. 每个话题的 title 中必须包含该关注领域的具体关键词，不能是泛化的热门话题`,
        `5. 如果用户领域偏专业/技术，用该领域的专业视角找趋势，不要强行套用娱乐化情绪模板`,
      ].join("\n")
    : '';

  for (const platform of platforms) {
    const platformLabel = platform === "xiaohongshu" ? "小红书" : platform === "douyin" ? "抖音" : platform;

    // Run script for real-time data
    const scriptData = await runTrendScript(platform);
    // BUGFIX: search keywords must include user interests
    const year = new Date().getFullYear();
    // Generate multi-dimensional search keywords for deep domain research
    const interestSearchTerms = interests.length
      ? interests.flatMap(i => [
          "\"" + i + " 趋势 " + year + "\"",
          "\"" + i + " 最新政策 " + year + "\"",
          "\"" + i + " 教程 干货\"",
          "\"" + i + " 案例 分析\"",
          "\"" + i + " 争议 热议\"",
        ]).join(" ")
      : "";
    const dataClause = scriptData
      ? `\n以下是通过 API 获取的 ${platformLabel} 实时热搜数据。请筛选其中与用户关注领域相关的条目：\n\`\`\`json\n${scriptData.slice(0, 4000)}\n\`\`\`\n`
      : `\n无法通过 API 获取实时数据。请使用 WebSearch 按以下关键词搜索：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}" "${platformLabel} 热门话题 最新 ${year}"`}\n${interests.length ? `\n**注意**：搜索结果必须围绕用户关注领域展开。不要返回与用户领域无关的泛热门内容。` : ""}\n`;

    const prompt = [
      `你是一个专业的社交媒体趋势研究员。请分析 ${platformLabel} 平台上用户关注领域的最新内容趋势。`,
      dataClause,
      interestClause,
      ``,
      `## 话题推荐维度（按优先级排序）`,
      ``,
      `1. **领域热度**（最高优先级）：这个方向在用户关注领域内的讨论度有多高？`,
      `2. **信息价值**：是否能给目标观众带来新知或启发？（教程、科普、行业洞察优先于纯娱乐）`,
      `3. **创作可行性**：用户能否基于这个话题做出有差异化的内容？`,
      `4. **传播潜力**（辅助参考）：话题本身是否自带传播属性？`,
      ``,
      `## 情绪适配（自然优先 — 不强制套用）`,
      ``,
      `当话题自然契合以下情绪时标注对应 emotionType。如果话题不适合任何情绪框架（如知识科普），emotionType 填 "信息价值"：`,
      `- **焦虑**：落后焦虑/错过焦虑/被替代焦虑 — 仅当话题自带紧迫感时使用`,
      `- **愤怒**：不公/双标/价值观冲突 — 仅当话题涉及争议时使用`,
      `- **搞笑**：反转/共鸣/错位 — 仅当话题有幽默元素时使用`,
      `- **羡慕**：想成为/想拥有 — 仅当话题展示理想生活/成就时使用`,
      `- **信息价值**：教程/科普/行业分析/深度解读 — 知识类话题的默认类型`,
      ``,
      `输出严格 JSON（不要 Markdown，只输出 JSON 对象）：`,
      `{"topics":[{`,
      `  "title":"话题标题（必须体现具体领域关键词）",`,
      `  "heat":4,`,
      `  "competition":"中",`,
      `  "opportunity":"金矿",`,
      `  "emotionType":"信息价值",`,
      `  "emotionSubtype":"行业分析",`,
      `  "description":"趋势描述和为什么值得做",`,
      `  "tags":["领域标签1","领域标签2","推荐标签"],`,
      `  "contentAngles":["从用户领域出发的切入角度1","切入角度2"],`,
      `  "exampleHook":"爆款开头示例（体现领域特色）",`,
      `  "category":"所属领域"`,
      `}]}`,
      ``,
      `要求：`,
      `- topics 至少 10 个`,
      `- heat 为 1-5 整数`,
      `- competition 为 "低"/"中"/"高"`,
      `- opportunity 为 "金矿"(高热低竞)/"蓝海"(低热低竞)/"红海"(高热高竞)`,
      `- emotionType 优先使用 "信息价值"/"焦虑"/"愤怒"/"搞笑"/"羡慕"，知识类话题默认 "信息价值"`,
      `- emotionSubtype 必填，为该情绪或信息类型的具体子类型`,
      `- tags 3-5 个，必须包含用户关注领域的相关关键词`,
      `- contentAngles 2-3 个具体的内容切入角度，必须从用户关注领域出发`,
      `- exampleHook 一句话的爆款开头示例，必须体现领域特色`,
      `- category 为话题所属领域，优先使用用户关注领域中的分类`,
      `- **如果用户关注领域较专业，topics 中技术/行业类话题应占比 >= 70%**`,
    ].join("\n");

    try {
      const result = await runCliBrief(prompt);
      const stripped = result.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
      const firstBrace = stripped.indexOf("{");
      const lastBrace = stripped.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) {
        errors.push(platform);
        continue;
      }

      const data = JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      if (!data.topics || !Array.isArray(data.topics)) {
        errors.push(platform);
        continue;
      }

      const trendsDir = join(homedir(), ".autoviral", "trends", platform);
      await mkdir(trendsDir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      await writeFile(
        join(trendsDir, `${dateStr}.yaml`),
        yaml.dump(data, { lineWidth: -1 }),
        "utf-8"
      );

      collected.push(platform);
    } catch {
      errors.push(platform);
    }
  }

  return { collected, errors };
}

// GET /api/trends/:platform — return latest trend data (prefer data.json, fall back to YAML)
apiRoutes.get("/api/trends/:platform", async (c) => {
  const platform = c.req.param("platform");
  const trendsDir = join(homedir(), ".autoviral", "trends", platform);

  // Try data.json first (written by agent)
  try {
    const raw = await readFile(join(trendsDir, "data.json"), "utf-8");
    return c.json(JSON.parse(raw));
  } catch { /* fall through */ }

  // Fall back to dated YAML files
  try {
    const files = await readdir(trendsDir);
    const yamlFiles = files.filter(f => f.endsWith(".yaml")).sort().reverse();
    if (yamlFiles.length === 0) return c.json({ error: "No trend data available" }, 404);
    const raw = await readFile(join(trendsDir, yamlFiles[0]), "utf-8");
    const data = yaml.load(raw);
    return c.json(data);
  } catch {
    return c.json({ error: "No trend data available" }, 404);
  }
});

// GET /api/trends/:platform/report — return the markdown research report
apiRoutes.get("/api/trends/:platform/report", async (c) => {
  const platform = c.req.param("platform");
  try {
    const reportPath = join(homedir(), ".autoviral", "trends", platform, "report.md");
    const report = await readFile(reportPath, "utf-8");
    return c.text(report);
  } catch {
    return c.text("", 404);
  }
});

// POST /api/trends/refresh — trigger research collection
apiRoutes.post("/api/trends/refresh", async (c) => {
  try {
    const body = await c.req.json<{ platforms?: string[] }>().catch(() => ({}));
    const platforms = (body as any).platforms ?? ["xiaohongshu", "douyin"];
    const result = await researchTrends(platforms);
    return c.json({ triggered: true, type: "research", ...result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Collection failed" }, 500);
  }
});

// POST /api/trends/refresh-stream — streaming trend research via WsBridge
apiRoutes.post("/api/trends/refresh-stream", async (c) => {
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  try {
    const body = await c.req.json<{ platform?: string; interests?: string[]; competitors?: string[] }>().catch(() => ({}));
    const platform = (body as any).platform ?? "douyin";
    const platformLabel = platform === "xiaohongshu" ? "小红书" : platform === "douyin" ? "抖音" : platform;

    const sessionKey = `trends_${platform}_${Date.now()}`;

    // 1. Get user interests and competitors
    const config = await loadConfig();
    const reqInterests = (body as any).interests ?? config.interests ?? [];
    const interests = Array.isArray(reqInterests) ? reqInterests : [];
    const rawCompetitors = ((body as any).competitors ?? []) as string[];
    const competitors = Array.isArray(rawCompetitors) ? rawCompetitors : [];
    // BUGFIX: user interests are the PRIMARY driver, emotion constraint is secondary
    const interestClause = interests.length > 0
      ? [
          ``,
          `## 用户关注领域（核心驱动 - 最高优先级）`,
          ``,
          `用户指定了以下关注领域：**${interests.join("、")}**`,
          ``,
          `**强制规则：**`,
          `1. 至少 70% 的推荐话题必须直接属于用户关注的领域或其紧密相关子领域`,
          `2. 每个关注领域至少覆盖 3-5 个话题。如果一个领域太大，请拆分为具体子方向`,
          `3. 不相关的泛热门话题最多占 30%，用于补充视野`,
          `5. 如果用户领域偏专业/技术，用该领域的专业视角找趋势`,
        ].join("\n")
      : '';
    const competitorClause = competitors.length > 0
      ? `\n用户关注的竞品账号：${competitors.join("、")}。请参考这些账号的内容方向和爆款模式。\n`
      : '';

    // 2. Run script for real-time data
    const scriptData = await runTrendScript(platform);
    // BUGFIX: search keywords must include user interests
    const year = new Date().getFullYear();
    // Generate multi-dimensional search keywords for deep domain research
    const interestSearchTerms = interests.length
      ? interests.flatMap(i => [
          "\"" + i + " 趋势 " + year + "\"",
          "\"" + i + " 最新政策 " + year + "\"",
          "\"" + i + " 教程 干货\"",
          "\"" + i + " 案例 分析\"",
          "\"" + i + " 争议 热议\"",
        ]).join(" ")
      : "";
    const dataClause = scriptData
      ? `\n以下是通过 API 获取的 ${platformLabel} 实时热搜数据。请筛选其中与用户关注领域相关的条目：\n\`\`\`json\n${scriptData.slice(0, 4000)}\n\`\`\`\n`
      : `\n无法通过 API 获取实时数据。请使用 WebSearch 按以下关键词搜索：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}" "${platformLabel} 热门话题 最新 ${year}"`}\n${interests.length ? `\n**注意**：搜索结果必须围绕用户关注领域展开。` : ""}\n`;

    // 3. Build enhanced prompt — agent writes files to trends output dir
    const outputDir = join(homedir(), ".autoviral", "trends", platform);
    const dataFile = join(outputDir, "data.json");
    const reportFile = join(outputDir, "report.md");

    const prompt = [
      `你是一个专业的社交媒体趋势研究员。请分析 ${platformLabel} 平台上用户关注领域的最新内容趋势。`,
      dataClause,
      interestClause,
      competitorClause,
      ``,
      `## 推荐维度（按优先级排序）`,
      ``,
      `1. **领域热度**（最高优先级）：话题在用户关注领域内的讨论度`,
      `2. **信息价值**：是否给目标观众带来新知（教程、科普优先于纯娱乐）`,
      `3. **创作可行性**：用户能否做出有差异化的内容`,
      `4. **传播潜力**（辅助）：话题自带传播属性`,
      ``,
      `## 情绪标注（自然优先 — 不强制套用）`,
      ``,
      `当话题自然契合以下情绪时标注对应 emotionType。如果不适合任何情绪框架（如知识科普），emotionType 填 "信息价值"：`,
      `- 焦虑：话题自带紧迫感时使用`,
      `- 愤怒：话题涉及争议时使用`,
      `- 搞笑：话题有幽默元素时使用`,
      `- 羡慕：话题展示理想生活/成就时使用`,
      `- 信息价值：知识、教程、科普、行业分析的默认类型`,
      ``,
      `完成分析后，请将结果写入以下两个文件：`,
      ``,
      `**文件 1: ${dataFile}**`,
      `写入 JSON 格式的结构化趋势数据：`,
      `{"topics":[{`,
      `  "title":"话题标题",`,
      `  "heat":4,`,
      `  "competition":"中",`,
      `  "opportunity":"金矿",`,
      `  "emotionType":"信息价值",`,
      `  "emotionSubtype":"行业分析",`,
      `  "description":"趋势描述和为什么值得做",`,
      `  "tags":["领域标签1","领域标签2","推荐标签"],`,
      `  "contentAngles":["从用户领域出发的切入角度1","切入角度2"],`,
      `  "exampleHook":"爆款开头示例（体现领域特色）",`,
      `  "category":"所属领域"`,
      `}]}`,
      `- topics 至少 10 个`,
      `- heat 为 1-5 整数，competition 为 "低"/"中"/"高"`,
      `- opportunity 为 "金矿"(高热低竞)/"蓝海"(低热低竞)/"红海"(高热高竞)`,
      `- emotionType 优先使用 "信息价值"/"焦虑"/"愤怒"/"搞笑"/"羡慕"，知识类话题默认 "信息价值"`,
      `- emotionSubtype 必填，为该情绪或信息类型的具体子类型`,
      `- tags 3-5 个，必须包含用户关注领域的相关关键词`,
      `- contentAngles 2-3 个具体的内容切入角度，必须从用户关注领域出发`,
      `- exampleHook 一句话的爆款开头示例，必须体现领域特色`,
      `- category 为话题所属领域，优先使用用户关注领域中的分类`,
      `- **如果用户关注领域较专业，topics 中技术/行业类话题应占比 >= 70%**`,
      ``,
      `**文件 2: ${reportFile}**`,
      `写入一份中文的 Markdown 格式趋势研究报告，包含：`,
      `- 标题：# ${platformLabel} 趋势研究报告`,
      `- 研究日期`,
      `- 整体趋势概述（当前平台的核心热点方向，2-3段）`,
      `- 各话题的详细分析（按热度排序，每个话题包含：为什么火、竞争情况、适合什么类型的创作者、具体的内容建议）`,
      `- 行动建议（给小创作者的 3-5 条可执行建议）`,
      ``,
      `先写 data.json，再写 report.md。两个文件都必须写入。`,
    ].join("\n");

    await wsBridge.createTrendSession(sessionKey, prompt);
    return c.json({ sessionKey, platform });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to start research" }, 500);
  }
});

// POST /api/trends/cancel/:sessionKey — cancel trend research
apiRoutes.post("/api/trends/cancel/:sessionKey", async (c) => {
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  const sessionKey = c.req.param("sessionKey");
  const killed = wsBridge.killTrendSession(sessionKey);
  return c.json({ cancelled: killed });
});

// ---------------------------------------------------------------------------
// Work Chat API (WsBridge)
// ---------------------------------------------------------------------------

// POST /api/works/:id/abort — abort running task for a work
apiRoutes.post("/api/works/:id/abort", async (c) => {
  const id = c.req.param("id");
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);
  const killed = wsBridge.killSession(id);
  return c.json({ aborted: killed });
});

/**
 * 启动作品的 agent 创作会话（有模板/数字人时为全自动模式，否则为确认模式）。
 * POST /api/works/:id/session 与批量自动流水线共用。
 * extraInstruction：额外指令（如发布中心打回的审核意见），拼入开场 prompt。
 */
export async function startWorkSession(id: string, extraInstruction?: string): Promise<{ status: string; step?: string }> {
  if (!wsBridge) throw new Error("WsBridge not initialized");
  const existing = wsBridge.getSession(id);
  if (existing?.cliProcess) return { status: "already_running" };

  const work = await getWork(id);
  if (!work) throw new Error("Work not found");

  // Look up account tone profile for style injection
  const account = work.accountId ? getAccount(work.accountId) : undefined;
  const toneInjection = account
    ? `\n账号名称：${account.name}\n平台：${account.platform === "douyin" ? "抖音" : account.platform === "xiaohongshu" ? "小红书" : account.platform}\n${buildTonePrompt(account.tone_profile)}`
    : "";

  const steps = Object.entries(work.pipeline);
  const pendingStep = steps.find(([, s]) => s.status === "pending" || s.status === "active");
  const stepName = pendingStep ? pendingStep[1].name : steps[0]?.[1]?.name ?? "创作";
  const stepKeys = steps.map(([k]) => k);
  const currentStepKey = pendingStep ? pendingStep[0] : stepKeys[0];

  const hasTemplate = !!work.templateId;
  const hasDigitalHuman = !!work.digitalHumanId;
  // 已有 done 数字人任务 = 口播已渲染（可能来自批量渲染阶段），素材准备步骤直接取现成产物
  const digitalHumanDone = hasDigitalHuman && dhJobsRepo.listJobs(id).some((j) => j.status === "done");
  // 模式判定(2026-08-16 用户决策)：全自动开关 = 创建入口(批量按钮落 auto_mode=1)。
  // 不再用模板/数字人推断——深度介入作品也可以选模板,批量作品也可以不选模板。
  const isUnattended = !!work.autoMode;

  const prompt = [
    `你是一个内容创作助手。你正在帮助用户创作: "${work.title}" (类型: ${work.type})。`,
    `目标平台: ${work.platforms.map((p: any) => typeof p === "string" ? p : p.platform).join(", ")}。`,
    work.topicHint ? `选题方向: ${work.topicHint}` : "",
    // 素材三维约束（批量制作传入并落库 works.asset_*，会话启动时拼入指令）
    buildAssetConstraintSection(work.assetForm, work.assetSource, work.assetBudget, hasDigitalHuman),
    work.dualOutput ? `双产物: 本作品需同时产出短视频与图文（内容一致、素材共用），视频合成完成后派生图文产物` : "",
    hasTemplate ? buildTemplateSection(work.templateId) : "",
    hasDigitalHuman ? `使用数字人: ${work.digitalHumanId}` : "",
    // 未选数字人时显式禁用(2026-08-14):此前只在选了才提数字人,agent 看到 smart 路由里
    // "口播→数字人"就自行绑定 avatar 渲染,违背用户"不用数字人"的选择
    work.type === "short-video" && !hasDigitalHuman
      ? `数字人: 用户未选择数字人——全片禁止出现数字人/虚拟人口播镜头,不得自行绑定 avatar 或调用数字人渲染接口;口播内容用克隆配音+字幕/图解/实拍画面呈现`
      : "",
    digitalHumanDone
      ? `数字人口播已渲染完成（见数字人任务列表），素材准备步骤直接使用，无需重复渲染`
      : hasDigitalHuman
        ? `到达素材准备步骤时，调用 POST /api/works/${id}/digital-human/run 渲染数字人口播，然后轮询 GET /api/digital-humans/jobs/:jobId 直至 done`
        : "",
    toneInjection,
    // 打回重做的审核意见随会话启动注入（打回 → 会话死亡 → 重建的场景下
    // 意见不丢失，agent 始终知道要改什么 —— 2026-07-21）
    work.reviewComment ? `最近审核打回意见（必须遵守并据此修改）: ${work.reviewComment}` : "",
    extraInstruction ?? "",
    ``,
    `当前步骤: "${stepName}"（key: ${currentStepKey}）。流水线阶段顺序: ${stepKeys.join(" → ")}。`,
    isUnattended
      ? [
          // 如实声明用户预设了哪些(此前无论是否选数字人都声称"已设定好模板和数字人",
          // 导致 agent 在未选数字人时自行绑定 avatar —— 2026-08-14 bug)
          `**自动化模式（无人值守）**：用户已预先设定好${[hasTemplate ? "模板" : "", hasDigitalHuman ? "数字人" : ""].filter(Boolean).join("和")}，请直接执行当前步骤，不要询问用户确认。`,
          `**自主拍板铁律**：本作品全程无真人在线。所有创意决策——立场角度、钩子版本(多版本自行择优落地,不要列出来让人挑)、标题与封面、素材来源、配乐——均由你按 skills 的推荐方案自行决定并立即执行。禁止向用户提问、罗列备选等用户选择、或停下来等确认;系统提示与 skill 中"请用户确认/等用户确认"类规则对本作品一律不适用。`,
          `完成当前步骤后，必须调用以下命令推进流水线（把 NEXT_STEP 替换为下一阶段 key）：`,
          `curl -X POST http://localhost:3271/api/works/${id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"${currentStepKey}","nextStep":"NEXT_STEP"}'`,
          `推进后系统会自动给你发送继续指令，请接着执行下一阶段，如此循环直到最后一个阶段完成。`,
        ].join("\n")
      : `请先向用户确认：简要说明这个步骤你将做什么，询问用户是否有特定方向或要求，等用户确认后再开始工作。不要直接开始执行，先和用户沟通。`,
  ].filter(Boolean).join("\n");

  const config = await loadConfig();
  await wsBridge.createSession(id, prompt, config.model);
  return { status: "started", step: stepName };
}

// POST /api/works/:id/session
apiRoutes.post("/api/works/:id/session", async (c) => {
  const id = c.req.param("id");
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  try {
    const result = await startWorkSession(id);
    return c.json({ ...result, workId: id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Session start error" }, 500);
  }
});

// POST /api/works/:id/chat
apiRoutes.post("/api/works/:id/chat", async (c) => {
  const id = c.req.param("id");
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  try {
    const body = await c.req.json<{ text: string }>();
    if (!body.text) return c.json({ error: "text is required" }, 400);

    let session = wsBridge.getSession(id);
    if (!session) {
      const config = await loadConfig();
      session = await wsBridge.createSession(id, body.text, config.model);
      return c.json({ sent: true, sessionCreated: true, workId: id });
    }

    const sent = await wsBridge.sendMessage(id, body.text);
    if (!sent) return c.json({ error: "Failed to send message" }, 500);
    return c.json({ sent: true, workId: id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Chat error" }, 500);
  }
});

// POST /api/works/:id/step/:step
apiRoutes.post("/api/works/:id/step/:step", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  try {
    const work = await getWork(id);
    if (!work) return c.json({ error: "Work not found" }, 404);

    const pipelineStep = work.pipeline[step];
    if (!pipelineStep) return c.json({ error: `Unknown pipeline step: ${step}` }, 404);

    // Check prerequisites: all preceding steps must be done/skipped
    const stepKeys = Object.keys(work.pipeline);
    const stepIdx = stepKeys.indexOf(step);
    for (let i = 0; i < stepIdx; i++) {
      const prev = work.pipeline[stepKeys[i]];
      if (prev.status !== "done" && prev.status !== "skipped") {
        return c.json({ error: `Previous step "${prev.name}" is not completed` }, 400);
      }
    }

    const isAutoMode = !!work.autoMode;
    const autoModeDirective = isAutoMode
      ? [
          ``,
          `## AUTOMATED MODE`,
          `This work is running in automated mode (batch auto-pipeline).`,
          `DO NOT ask the user to choose from options. Automatically select the best option and proceed.`,
          `DO NOT wait for user confirmation between steps. Execute each step completely and move to the next one automatically.`,
          `After completing this step, automatically trigger the next pipeline step via:`,
          `\`curl -X POST http://localhost:3271/api/works/${id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"${step}","nextStep":"NEXT_STEP"}'\``,
          ``,
        ].join("\n")
      : "";

    const promptParts = [
      `You are working on a content piece: "${work.title}" (type: ${work.type}).`,
      work.contentCategory ? `Content category: ${work.contentCategory}.` : "",
      `Platforms: ${work.platforms.map((p: any) => typeof p === "string" ? p : p.platform).join(", ")}.`,
      work.topicHint ? `Topic hint: ${work.topicHint}` : "",
      work.templateId ? buildTemplateSection(work.templateId) : "",
      work.digitalHumanId ? `Digital Human: ${work.digitalHumanId}` : "",
      autoModeDirective,
      ``,
    ];

    if (step === "material-search" && work.videoSearchQuery) {
      promptParts.push(
        `Execute the "视频搜索" step.`,
        `The user wants to find existing videos from the web. Search query: "${work.videoSearchQuery}"`,
        ``,
        `## CRITICAL: Five-Dimension Constraint Analysis`,
        `Before searching, you MUST parse the search query into 5 dimensions and treat them as hard constraints:`,
        `1. **Absolute Subject & Physical Motion** — Who/what must appear, doing what? Subject must be visible EVERY SECOND.`,
        `2. **Environment & Emotional Lighting** — What scene/setting? What light mood?`,
        `3. **Optics & Camera** — What shot type, angle, movement?`,
        `4. **Timeline & State Evolution** — Duration required? Speed (normal/slow/fast)? How does the subject change over time?`,
        `5. **Aesthetic Medium & Rendering** — Live action / animation / 3D? Color tone? Resolution?`,
        ``,
        `Parse the query "${work.videoSearchQuery}" into these 5 dimensions first. State which are hard constraints (explicitly mentioned) vs soft constraints (inferred). Then search accordingly.`,
        `ALL returned videos must satisfy ALL hard constraints. If a video violates any (e.g. subject disappears mid-way), discard it.`,
        ``,
        `## Instructions`,
        `1. Search the web for 3 matching videos using WebSearch.`,
        `2. For each video found, download it WITH AUDIO using yt-dlp and save to the work assets directory.`,
        `   - First check if yt-dlp is available: \`which yt-dlp || pip3 install yt-dlp\``,
        `   - Download command (MUST use this to get audio+video merged):`,
        `     \`yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "/path/to/option-01.mp4" "VIDEO_URL"\``,
        `   - Save videos to the work assets directory. Find the path with:`,
        `     \`curl -s http://localhost:3271/api/works/${work.id} | python3 -c "import sys,json; w=json.load(sys.stdin); print(w.get('path',''))" || echo "$HOME/.autoviral/works/${work.id}/assets/clips"\``,
        `   - Save as: option-01.mp4, option-02.mp4, option-03.mp4`,
        `   - NEVER use plain curl to download videos — it will only get the video stream without audio.`,
        `3. Present the 3 options to the user using markdown video links so they display as inline players:`,
        `   - Use this format: \`[Video Title](/api/works/${work.id}/assets/clips/option-01.mp4)\``,
        `   - The .mp4 link format will render as an inline video player in the chat.`,
        `4. Ask the user to choose one of the 3 videos.`,
        `5. After the user selects, rename/copy the chosen video as the primary clip and mark this step as done:`,
        `   \`curl -X POST http://localhost:3271/api/works/${work.id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"material-search","nextStep":"research"}'\``,
        ``,
        `IMPORTANT:`,
        `- Video files MUST have audio. Always use yt-dlp with audio merging, never plain curl/wget.`,
        `- Files must be actually downloaded and saved as assets so the inline player can play them.`,
      );
    } else if (step === "research") {
      // Load user interests and competitors for topic relevance
      const config = await loadConfig();
      const userInterests = (config.interests ?? []) as string[];
      const douyinUrl = config.analytics.sources.find((s) => s.platform === "douyin")?.accountUrl ?? "";
      const cat = (work.contentCategory as string) ?? "";

      // --- Info sufficiency check (OPT-1) ---
      const hasTopicHint = !!(work.topicHint && work.topicHint.trim());
      const hasTitle = !!(work.title && work.title.trim() && work.title !== "未命名作品" && work.title !== "Untitled");
      const isOtherCategory = cat === "other" || !cat;

      const sufficiencyCheck = [
        `## 信息充分性检查（开始调研前必须执行）`,
        ``,
        `在开始调研之前，先评估用户提供的信息是否足够：`,
        hasTopicHint
          ? `✅ 用户指定了创作方向："${work.topicHint}"，围绕此方向深入调研。`
          : `⚠️ 用户未指定具体创作方向。请先向用户提 1-2 个问题确认想做什么内容，不要用默认值硬跑。`,
        hasTitle
          ? `✅ 作品标题："${work.title}"`
          : `⚠️ 无明确标题。`,
        isOtherCategory
          ? `ℹ️ 用户选择了"其他"类型或未选类型，请在对话中了解用户想做什么类型的内容（叙事/知识/展示/节奏/情绪驱动等），再决定调研方向。`
          : `ℹ️ 情绪品类：${cat}`,
        ``,
        `如果以上信息不足以开始有针对性的调研，先和用户对话确认方向，再执行下面的调研步骤。`,
        ``,
      ].join("\n");

      // --- Topic hint priority (BUG-1 / ARCH-3) ---
      const topicDirective = hasTopicHint
        ? [
          `## 创作方向（最高优先级）`,
          ``,
          `用户明确指定了创作方向："${work.topicHint}"`,
          `所有调研内容必须围绕此方向展开。热搜仅用于选标签蹭流量，不影响内容主题。`,
          ``,
        ].join("\n")
        : "";

      // --- Interests as soft reference (ARCH-3 fix) ---
      const interestClause = userInterests.length > 0
        ? `\n## 参考领域\n\n用户关注的领域：${userInterests.join("、")}。可以参考这些领域选择角度和标签，但不强制要求内容必须属于这些领域。${hasTopicHint ? "用户指定的创作方向优先级高于参考领域。" : ""}\n`
        : "";

      const competitorClause = douyinUrl
        ? `\n用户的竞品账号：${douyinUrl}。选题风格和受众定位可以参考这个账号的方向。\n`
        : "";

      // --- Emotion-specific content (only for emotion categories, not "other") ---
      const emotionEffect: Record<string, string> = {
        anxiety: "看完之后感到焦虑、危机感、害怕自己落后或错过",
        conflict: "看完之后感到愤怒、不公、想站队、想在评论区吵架",
        envy: "看完之后感到羡慕、向往、想收藏、想拥有同样的生活",
      };
      const routeTemplates: Record<string, string> = {
        anxiety: [
          `路线1 观点输出型：文字卡片封面（≤20字，一句极端观点）+ 文案（第一人称+身边案例+绝对表态）`,
          `路线2 对话截图型：微信对话截图封面 + 一句话文案`,
          `路线3 清单盘点型：极端判断句封面 + 清单图 + 文案`,
        ].join("\n"),
        conflict: [
          `路线1 观点输出型：文字卡片封面（≤20字，一句极端观点）+ 文案（第一人称+身边案例+绝对表态）`,
          `路线2 对话截图型：微信对话截图封面 + 一句话文案`,
          `路线3 清单盘点型：极端判断句封面 + 清单图 + 文案`,
        ].join("\n"),
        envy: [
          `路线1 反差跃迁型：before/after 两张搜图 + 文案强调路径短`,
          `路线2 关系羡慕型：1-5张甜蜜瞬间搜图（风格统一）+ 一句话文案`,
          `路线3 隐性阶层信号型：1-5张日常搜图（细节暗示阶层）+ 轻描淡写文案`,
        ].join("\n"),
      };

      const isEmotionCategory = ["anxiety", "conflict", "envy"].includes(cat);
      const isComedy = cat === "comedy";

      if (isComedy) {
        // Comedy research handled below in the comedy block
        promptParts.push([
          `Execute the "${pipelineStep.name}" step.`,
          ``,
          sufficiencyCheck,
          topicDirective,
          interestClause,
          competitorClause,
        ].join("\n"));
      } else if (isEmotionCategory) {
        // Emotion-driven research (existing logic, restructured)
        promptParts.push([
          `Execute the "${pipelineStep.name}" step.`,
          ``,
          sufficiencyCheck,
          topicDirective,
          `## 你要产出什么`,
          ``,
          `3 个完整的图文选题，每个可以直接复制粘贴去小红书/抖音发布。`,
          interestClause,
          competitorClause,
          `## 内容视角：永远是"我"的故事`,
          ``,
          `这不是新闻报道。所有内容都是发布者以**第一人称**在聊自己的主观感受、自己的经历、自己的处境。`,
          ``,
          `正确示例：`,
          `- "我今年28，单身，没房没车。我妈说我是废物。"（第一人称，聊自己）`,
          `- "我老公今天突然送了我一束花，没有任何原因。"（第一人称，聊自己的关系）`,
          `- "周三下午，一个人坐在阳台上喝咖啡。"（第一人称，聊自己的日常）`,
          ``,
          `错误示例（绝对禁止）：`,
          `- "某地房价暴跌30%，购房者损失惨重"（这是新闻报道，不是个人帖子）`,
          `- "年轻人就业压力增大，专家建议..."（这是客观分析，不是个人感受）`,
          `- "据统计，2026年考研人数再创新高"（这是数据引用，不是个人故事）`,
          ``,
          `热点话题只用来选标签、蹭流量，内容本身必须是"我"的故事。`,
          ``,
          hasTopicHint
            ? [
              `## 第一步：围绕创作方向深入搜索`,
              ``,
              `用 WebSearch 搜索"${work.topicHint}"相关的最新动态、热门讨论、优质案例。`,
              `深入了解这个方向的内容生态、受众偏好、爆款模式。`,
              ``,
              `## 第二步：找热门标签（仅用于蹭流量）`,
              ``,
              `用 WebSearch 搜索"${work.topicHint} 热搜""抖音 热门标签"，找到与创作方向相关的热门标签。`,
              `标签只是发布时的流量工具，不影响内容主题。`,
            ].join("\n")
            : [
              `## 第一步：搜索当前热门标签`,
              ``,
              `用 WebSearch 搜索"今日热搜""微博热搜""抖音热点"，找到当前有热度的话题。`,
              `这些话题只用来选标签（蹭流量），不是用来写内容的。`,
            ].join("\n"),
          ``,
          `## ${hasTopicHint ? "第三步" : "第二步"}：围绕${hasTopicHint ? "创作方向，构造" : "热门话题，构造"}"我"的故事`,
          ``,
          `每个选题的核心是一个虚构但真实感极强的第一人称故事/感受，读完后让观众${emotionEffect[cat] ?? "产生强烈情绪"}。`,
          ``,
          `构造方法：`,
          `1. 给"我"一个身份（年龄、职业、城市、处境）`,
          `2. 讲"我"的一段具体经历或此刻的感受`,
          `3. 让读者代入"我"的处境后，自然地${emotionEffect[cat] ?? "产生情绪"}`,
          ``,
          `## 3 条路线模板（3 个选题各用一条）`,
          ``,
          routeTemplates[cat] ?? "",
          ``,
          `## 输出格式：3 个完整选题`,
          ``,
          `每个选题包含：`,
          `1. **蹭的热门话题**：用来选标签的热点`,
          `2. **路线**：用的哪条路线`,
          `3. **封面**：文字卡片写出完整文字（≤20字）；搜图类给出关键词`,
          `4. **标题**：可以直接用的发布标题`,
          `5. **完整文案**：以"我"的第一人称写的完整成品文案，读起来像一个真人在倾诉自己的经历/感受`,
          `6. **标签**：5-6 个（从热搜中选）`,
          ``,
          `请用户从 3 个中选一个。`,
        ].join("\n"));
      } else {
        // "other" or unknown category — generic research with topic-driven approach
        promptParts.push([
          `Execute the "${pipelineStep.name}" step.`,
          ``,
          sufficiencyCheck,
          topicDirective,
          `## 你要产出什么`,
          ``,
          `针对用户的创作方向，进行深入调研并提出 3 个内容方案。`,
          interestClause,
          competitorClause,
          `## 调研方法`,
          ``,
          `1. 用 WebSearch 围绕用户的创作方向搜索相关热点、趋势、优质案例`,
          `2. 分析目标平台上同类内容的表现（标题风格、封面设计、标签策略）`,
          `3. 找到可以蹭的热门标签`,
          ``,
          `## 输出格式：3 个内容方案`,
          ``,
          `每个方案包含：`,
          `1. **内容定位**：这条内容是什么类型（叙事/知识/展示/情绪驱动/节奏型等）`,
          `2. **核心卖点**：为什么观众会停下来看、会互动`,
          `3. **标题**：可直接使用的发布标题`,
          `4. **内容大纲**：简要描述内容结构`,
          `5. **参考案例**：调研中发现的类似优质内容`,
          `6. **标签**：5-6 个平台标签`,
          ``,
          `请用户从 3 个中选一个。`,
        ].join("\n"));
      }
    } else {
      promptParts.push(
        `Execute the "${pipelineStep.name}" step of the pipeline.`,
        `Produce output appropriate for this step. Be thorough and creative.`,
      );
      if (step === "assets" && work.type === "short-video") {
        promptParts.push(
          ``,
          `## Asset Acquisition Strategy（合规素材库优先，自动检索选优）`,
          ``,
          `Read the storyboard/plan from the previous step. 按分镜脚本为每个镜头获取素材，严格按以下优先级执行：`,
          ``,
          `### 优先级 1：合规素材库（首选 —— 免费可商用、自带授权元数据，无版权风险）`,
          ``,
          `1. 为每个镜头构造**英文**搜索关键词（Pexels 对英文检索效果最好；从分镜的场景描述提取：主体 + 动作 + 环境，如 "ocean waves sunset beach"）`,
          `2. 搜索视频素材：`,
          `   \`curl -s "http://localhost:3271/api/stock-assets/search?q=KEYWORDS&type=video&perPage=10"\``,
          `   （如需图片素材把 type=video 换成 type=image）`,
          `3. 从结果中为该镜头选最优素材，打分维度（按重要性排序）：`,
          `   - **语义贴合**：主体/动作/场景与镜头脚本一致（由你判断，一票否决）`,
          `   - **画幅方向**：最终输出 9:16 竖版，竖版（height>width）素材最佳；横版可用但合成时需裁剪，优先级降低`,
          `   - **分辨率**：width ≥ 1080 优先`,
          `   - **时长**：duration 最好 ≥ 镜头所需时长 + 1 秒`,
          `4. 下载选中素材（自动进入合规素材库，带授权记录）：`,
          `   \`curl -X POST http://localhost:3271/api/stock-assets/download -H "Content-Type: application/json" -d '{"url":"ITEM_URL","provider":"pexels","mediaType":"video","category":"scenes","name":"shot-01.mp4","description":"...","author":"...","license":"...","duration":12}'\``,
          `   响应里的 asset.file_path 是共享素材库相对路径，完整路径为 ~/.autoviral/shared-assets/<file_path>，`,
          `   把文件复制到作品 assets 的 clips/ 目录供合成使用。`,
          `5. 每个镜头重复 1-4。`,
          ``,
          `### 优先级 2：yt-dlp 全网下载（仅当素材库找不到语义贴合的素材时）`,
          ``,
          `仅当某个镜头在素材库尝试 2-3 组关键词后仍无语义贴合的结果，才 fallback：`,
          `1. 搜索 YouTube/Bilibili: \`yt-dlp "ytsearch5:keywords" --get-title --get-url --get-duration\``,
          `2. 下载: \`yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4 -o "clips/clip-NN.mp4" "URL"\``,
          `3. 裁剪: \`ffmpeg -i clip.mp4 -ss START -to END -c copy -y trimmed.mp4\``,
          `4. 验证音频: \`ffprobe -v error -show_entries stream=codec_type -of csv=p=0 clip.mp4 | grep audio\``,
          `注意：yt-dlp 来源素材授权不明，能不用就不用；用了必须在素材清单里标注来源 URL。`,
          ``,
          `Do NOT use AI generation APIs unless the user explicitly requests it.`,
          `Read the SKILL.md section "素材获取方式：全网搜索下载" for yt-dlp details.`,
          `Save all clips to the work assets directory under clips/.`,
        );
      }
      if (step === "assembly" && work.type === "short-video") {
        // 绑定视频模板的作品:走模板渲染引擎(2026-08-13 模板契约修复),跳过自由 ffmpeg 教学
        const boundTemplate = work.templateId ? getTemplate(work.templateId) : undefined;
        if (boundTemplate && boundTemplate.kind !== "image-text") {
          promptParts.push(
            ``,
            `## 模板渲染模式(本作品已绑定视频模板,必须走此路径,禁止手写 ffmpeg 自由合成)`,
            `1. 获取完整模板 JSON: \`curl -s http://localhost:3271/api/templates/${boundTemplate.id}\`,确认变量槽位(variables)与图层结构`,
            `2. 把前序步骤产出的素材映射为变量值(本地绝对路径):视频片段/图片填素材变量,配音填 voice_audio(若声明),BGM 填 bgm(若声明),字幕填 subtitle_ass(若声明)`,
            `3. 提交渲染(异步任务):`,
            `   \`curl -X POST http://localhost:3271/api/works/${id}/render -H "Content-Type: application/json" -d '{"templateId":"${boundTemplate.id}","variables":{...},"assets":{...}}'\``,
            `   返回 { jobId };模板若声明了 host_video/voice_audio 变量,必须额外传 digitalHumanVideo/voiceAudio 字段`,
            `4. 轮询 \`curl -s http://localhost:3271/api/render-jobs/{jobId}\` 直至 status=completed;failed 时读 error 修正变量后重试`,
            `5. 产物在 output/ 目录;不要对产物再做二次合成`,
            `6. 渲染完成后必须写 output/copytext.md 发布文案:首句 2 秒内抓人(好奇缺口/大胆断言/痛点),正文 2-3 句,结尾自然 CTA(关注/收藏/评论),附 5-10 个话题标签(2-3 热门 + 2-3 垂类 + 1-2 品牌),语言匹配目标平台(抖音/小红书用中文)`,
          );
        } else {
        promptParts.push(
          ``,
          `## CRITICAL: Horizontal-to-Vertical Video Conversion`,
          `The final output MUST be 9:16 vertical (1080x1920). If any source clip is horizontal (wider than tall):`,
          ``,
          `**Strategy A (preferred): Full-screen crop — NO black bars**`,
          `\`ffmpeg -i input.mp4 -vf "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920" ...\``,
          `Use this when the subject stays in the center and won't be cut off.`,
          ``,
          `**Strategy B: Width-match with vertical centering — subject too wide to crop**`,
          `\`ffmpeg -i input.mp4 -vf "scale=1080:-2,pad=1080:1920:0:(oh-ih)/2:black" ...\``,
          `This scales width to 1080, then pads top and bottom EQUALLY to center vertically.`,
          `The formula \`(oh-ih)/2\` is critical — it puts equal black bars on top and bottom.`,
          ``,
          `**VERIFY**: After producing the final video, extract a frame and confirm:`,
          `- No content is off-center vertically`,
          `- If black bars exist, they must be EQUAL top and bottom`,
          `- Subject is not cropped unless Strategy A was deliberately chosen`,
          `\`ffmpeg -i final.mp4 -ss 3 -frames:v 1 -y /tmp/verify.png\``,
          ``,
          `## BGM 配乐与混音红线（强制）`,
          `- BGM 只能来自：公共素材库 music、/api/generate/music（MiniMax music-2.6，duration 参数自动补齐时长）、yt-dlp 免版权音乐。**禁止用 ffmpeg 合成正弦波/白噪声/棕噪声充当 BGM**——属于静默降质`,
          `- **混音必须用响度锚定，禁止拍脑袋 volume 比例**（实测 volume=0.15 也会盖过人声）：`,
          `  1. 旁白轨先归一化：\`loudnorm=I=-15:TP=-1.5:LRA=11\``,
          `  2. BGM 轨压到旁白以下约 19dB：\`loudnorm=I=-34:TP=-3:LRA=11\`，再 amix 混入`,
          `  3. 参考命令：\`ffmpeg -i narration.mp3 -i bgm.mp3 -filter_complex "[0:a]loudnorm=I=-15:TP=-1.5:LRA=11[v];[1:a]loudnorm=I=-34:TP=-3:LRA=11[bgm];[v][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]" -map 0:v -map "[a]" ...\``,
          `  4. BGM 能量强（重鼓点/重低频）时再降 3dB（I=-37）；旁白清晰度永远优先于氛围`,
          `- BGM 时长必须 ≥ 视频时长（/api/generate/music 传 duration 自动循环补齐）；接缝处交叉淡化`,
          `- 合成后必须验证：对成片跑 volumedetect，并抽一段旁白间隙确认 BGM 不喧宾夺主；有条件时用 sidechaincompress 让 BGM 随旁白自动闪避`,
          `- **静态卡防抖红线（强制）**：数据卡/图表/快照卡等静态图片转视频时，禁止裸用 zoompan 快速推镜（亚像素步进必然抖动）。只许三种呈现：①纯静态展示 + 淡入淡出转场；②必须推镜时先把图片 scale 到 ≥3 倍分辨率再 zoompan（如 \`scale=3240:-2,zoompan=z='min(zoom+0.0008,1.05)'\`，总变倍 ≤5%）；③走模板渲染。合成后抽相邻两帧比对，肉眼可见抖动即重做`,
          `- **布局安全区断言（必做）**：数字人窗口/字卡 overlay 的坐标矩形 与 字幕带矩形 不得相交。先确定字幕带的 y 区间（含字号行高），再选 overlay 坐标使其完全避开；二者由同一份布局常量计算，禁止分别拍脑袋写坐标`,
          `- 合成完成后抽帧复核：在 10%/50%/90% 三个时间点抽帧检查字幕与数字人/字卡无遮挡`,
          `- **出片质感红线（强制，2026-08-14）**：`,
          `  1. 统一调色：所有实拍素材混入前做基础色彩统一（\`eq=contrast=1.06:saturation=0.92:brightness=-0.02\` + 轻微冷色偏移 \`colorbalance=bs=0.06\`），避免各来源素材色温/曝光打架；与深蓝模板同片时画面整体偏冷`,
          `  2. 转场：镜头间用 0.3–0.5s 交叉淡化（xfade），禁止全片生硬硬切（hook 后的第一次切换可硬切保留冲击感）`,
          `  3. 收尾：结尾 0.8–1s 画面与音频同步淡出（fade=t=out + afade），禁止戛然而止`,
          `  4. 实拍素材过暗/过灰必须先校正再用；横版素材竖屏裁切时主体必须在画面中上 2/3 区域`,
          ``,
          `## REQUIRED: Generate Publishing Copytext & Tags`,
          `After producing the final video, you MUST also generate a publishing copytext file.`,
          `Write it to \`output/copytext.md\` in the work directory.`,
          ``,
          `The copytext MUST follow viral/爆款 principles:`,
          `- **Hook line (first sentence)**: Must grab attention in under 2 seconds of reading. Use curiosity gaps, bold claims, or relatable pain points.`,
          `- **Body (2-3 sentences max)**: Expand on the hook, add value or intrigue. Keep it conversational and platform-native.`,
          `- **Call to action**: Encourage engagement (关注/收藏/转发/评论). Be natural, not pushy.`,
          `- **Tags/Hashtags**: Include 5-10 relevant hashtags. Mix:`,
          `  - 2-3 high-traffic trending tags (热门标签)`,
          `  - 2-3 niche/topic-specific tags`,
          `  - 1-2 branded or unique tags`,
          `  - Format: #tag1 #tag2 #tag3 (each prefixed with #)`,
          ``,
          `Example format of copytext.md:`,
          `\`\`\``,
          `这个方法我后悔没早点知道...`,
          ``,
          `很多人不知道，其实只要掌握这个技巧就能轻松搞定。今天一次性讲清楚，看完直接上手！`,
          ``,
          `觉得有用就收藏起来，别划走了 👆`,
          ``,
          `#知识分享 #干货 #涨知识 #教程 #生活技巧`,
          `\`\`\``,
          ``,
          `The copytext language should match the target platform (Chinese for 抖音/小红书).`,
          `Tailor the tone to the content category and platform style.`,
        );
        }
      }
      // Inject emotion-driven directives based on content category
      const emotionMap: Record<string, string> = {
        anxiety: "焦虑 (anxiety/crisis). Read modules/emotional-hooks.md and apply the 焦虑 emotion rules. For image-text, use one of the 3 mandatory routes (观点输出/对话截图/清单盘点).",
        conflict: "愤怒 (conflict/debate). Read modules/emotional-hooks.md and apply the 愤怒 emotion rules. For image-text, use one of the 3 mandatory routes (观点输出/对话截图/清单盘点).",
        comedy: "搞笑/抽象 (comedy/abstract). Read genres/comedy.md and apply its rules to this step.",
        envy: "羡慕 (aspiration/envy). Read modules/emotional-hooks.md and apply the 羡慕 emotion rules. For image-text, use one of the 3 mandatory routes (反差跃迁/关系羡慕/隐性阶层信号).",
      };
      const emotionDirective = emotionMap[work.contentCategory as string];
      if (emotionDirective) {
        promptParts.push(
          ``,
          `## IMPORTANT: Target emotion for this content is ${emotionDirective}`,
        );
        // Additional comedy-specific directives
        if (work.contentCategory === "comedy") {
          promptParts.push(
            `## IMPORTANT: This is comedy/abstract content (搞笑/抽象类).`,
            `You MUST read the genres/comedy.md file in the current step's skill directory and apply its rules.`,
          );
          const comedyByStep: Record<string, string> = {
            research: [
              `For the research step, focus on:`,
              `- Finding trending comedy/abstract topics, memes, and formats on the target platform`,
              `- Analyzing what reversal types (经典反转/递进荒诞/错位/重复打破/平行对比/紧张崩塌/微观共鸣) are currently performing well`,
              `- For abstract content: which "mismatch dimensions" (感官错配/过度认真/过度随意/语境位移/形式解构/真实解构/平行宇宙) are trending`,
              `- Identifying comedy hooks and BGM trends`,
            ].join("\n"),
            plan: [
              `For the planning step, the script/storyboard MUST follow the comedy genre rules (see genres/comedy.md):`,
              `- Choose a specific structure from the 7 comedy types or 7 abstract types in the skill`,
              `- Design the Hook (first 3 seconds) using the Hook types table`,
              `- Write dialogue following the comedy dialogue rules (短句为王, 口语化, 留白)`,
              `- Plan BGM strategy (情绪铺垫反转 / 卡点强化 / 反差配乐 / 梗音乐)`,
              `- Plan sound effects at key moments (反转点必须有声音标记)`,
              `- For abstract content: define the two "mismatch dimensions" and ensure purity of each extreme`,
              `- Run the 爆款自检清单 before finalizing`,
            ].join("\n"),
            assembly: [
              `For the assembly step, you handle BOTH asset generation AND editing/compositing.`,
              ``,
              `### Editing & Compositing:`,
              `- Editing rhythm: normal during setup, sudden change at reversal point`,
              `- BGM must have a sound marker at the reversal point (静音/音效/换曲)`,
              `- Jump cuts for comedy, longer takes for abstract`,
              `- Add sound effects precisely (急刹车 at reversals, 静音0.3-0.5s before twists)`,
              `- For abstract: consider using silence instead of sound effects to maintain the "dead serious" tone`,
              `- Volume: dialogue 100%, BGM 15-25% during speech, 40-60% during visual-only`,
              ``,
              `### Available Scripts (MUST USE, do NOT write inline code):`,
              `- **BGM search**: Read \`modules/music-search.md\` for yt-dlp search/download workflow`,
              `- **Beat detection**: \`python3 ~/.claude/skills/content-assembly/scripts/beat-sync/detect_beats.py bgm.mp3 -o beats.json\``,
              `- **Beat-sync editing**: \`python3 ~/.claude/skills/content-assembly/scripts/beat-sync/beat_sync_edit.py --video source.mp4 --music bgm.mp3 --output final.mp4 --style dramatic\``,
              `- Read \`modules/beat-sync.md\` for detailed usage of 3 styles (fast/smooth/dramatic)`,
            ].join("\n"),
          };
          const comedyDirective = comedyByStep[step];
          if (comedyDirective) promptParts.push(comedyDirective);
        }
      }

      // For image-text assets step: enforce correct asset acquisition method per category
      if (step === "assets" && work.type === "image-text") {
        const assetMethod: Record<string, string> = {
          envy: [
            ``,
            `## 严禁 AI 生图！严禁 ffmpeg 生成文字卡片！所有图片（包括封面）必须从网上搜索下载真实照片`,
            ``,
            `"向往拥有/羡慕"类图文的**所有图片（封面图 + 内容图）**都必须是从网上搜索下载的真实照片。`,
            `- ❌ 禁止使用 AI 生成图片`,
            `- ❌ 禁止使用 ffmpeg 生成文字卡片作为封面`,
            `- ✅ 封面图也必须是真实照片——看似普通，但细节透露"中产以上层级"的照片`,
            ``,
            `### 封面图要求`,
            `通过细节（不是直接展示奢侈品）传达阶层信号：`,
            `- 地点：某个特定区域/场所（独立咖啡馆、大落地窗客厅、安静的街区）`,
            `- 时间：工作日白天在做某件悠闲的事（暗示不用上班）`,
            `- 行为：不赶时间、从容不迫的状态`,
            `照片风格：像 iPhone 随手拍的，自然光线，构图不能太精心，不能有摆拍痕迹。`,
            ``,
            `### 图2-5 要求`,
            `每张图内容不同，但**风格、清晰度、色调、画风必须完全一致**，像同一部手机同一天拍的。`,
            ``,
            `### 执行步骤`,
            `1. 从内容规划方案中提取每张图的搜图关键词（关键词要具体到场景细节）`,
            `2. 所有搜图关键词加上统一的风格限定词（如"自然光 手机拍摄 日常 真实"）`,
            `3. 用 WebSearch 搜索对应的图片`,
            `4. 用 curl 下载找到的图片，保存到作品的 assets/images/ 目录`,
            `5. 下载后用 ffmpeg 统一调色（亮度/对比度/色温），消除不同来源的色差`,
            `6. 如果某张图风格偏离太大，弃用重搜，不要强行调色凑数`,
            ``,
            `参考 modules/emotional-hooks.md 中羡慕类的素材生成指令获取详细规则。`,
          ].join("\n"),
          anxiety: [
            ``,
            `## 图片生成方式`,
            ``,
            `"危机感/焦虑"类图文：只有封面是文字卡片（用 ffmpeg 生成）。`,
            `**除封面外的其他图片禁止写文字观点！** 文字观点全部在文案正文里体现。`,
            `其余配图用与话题相关的真实照片（全网搜索下载）。`,
            `如果方案使用的是路线2（对话截图型），对话截图仅限封面，其余图用真实照片。`,
            `参考 modules/emotional-hooks.md 中焦虑类的素材生成指令。`,
          ].join("\n"),
          conflict: [
            ``,
            `## 图片生成方式`,
            ``,
            `"观点分歧/愤怒"类图文：只有封面是文字卡片（用 ffmpeg 生成）。`,
            `**除封面外的其他图片禁止写文字观点！** 文字观点全部在文案正文里体现。`,
            `其余配图用与话题相关的真实照片（全网搜索下载）。`,
            `如果方案使用的是路线2（对话截图型），对话截图仅限封面，其余图用真实照片。`,
            `参考 modules/emotional-hooks.md 中焦虑类的素材生成指令。`,
          ].join("\n"),
        };
        const method = assetMethod[work.contentCategory as string];
        if (method) promptParts.push(method);

        // Universal image quality directives for image-text content
        promptParts.push([
          ``,
          `## 图片质量要求（适用于所有图文内容）`,
          ``,
          `### AI 生图质量标准`,
          `如果使用 AI 生图 API（/api/generate/image），prompt 中必须包含：`,
          `1. **画质关键词**：high quality, professional, detailed, 4K, sharp focus, masterpiece`,
          `2. **构图要求**：rule of thirds, balanced composition, clean background`,
          `3. **光影要求**：natural lighting, soft shadows, professional color grading`,
          `4. **风格统一**：同一组图片必须使用相同的风格描述词（如 "minimalist flat illustration" 或 "realistic photography style"）`,
          `5. **尺寸**：竖版 1080x1440 或 1080x1350（小红书/抖音图文标准比例 3:4）`,
          ``,
          `### ffmpeg 文字卡片质量标准`,
          `如果使用 ffmpeg 生成文字卡片（封面），必须达到以下标准：`,
          `1. **分辨率**：1080x1440（竖版高清）`,
          `2. **背景**：使用渐变色背景（不要纯黑/纯白），推荐配色：`,
          `   - 深蓝渐变: "linear-gradient(#1a2a6c, #b21f1f, #fdbb2d)" 效果`,
          `   - 用 ffmpeg 生成：先创建纯色背景，再用 overlay 添加文字`,
          `3. **字体**：使用系统中文字体（SimHei 或 Microsoft YaHei），字号 48-72px`,
          `4. **文字效果**：添加描边（borderw=2）和阴影（shadow），确保可读性`,
          `5. **布局**：文字居中，留白充足，不要堆砌`,
          `6. **命令模板**：`,
          `   ffmpeg -f lavfi -i color=c=0x1a2a6c:s=1080x1440 -vf \\`,
          `   "drawtext=text='标题文字':fontfile='C:/Windows/Fonts/msyh.ttc':fontsize=56:fontcolor=white:`,
          `   borderw=3:bordercolor=black@0.5:shadowx=2:shadowy=2:shadowcolor=black@0.3:`,
          `   x=(w-text_w)/2:y=(h-text_h)/2" -frames:v 1 -y cover.png`,
          ``,
          `### 搜索图片质量标准`,
          `1. 搜索关键词加上 "高清" "4K" "wallpaper" 等画质限定词`,
          `2. 下载后检查图片分辨率，低于 800px 宽度的弃用重搜`,
          `3. 用 ffmpeg 统一调整为 1080x1440（裁剪而非拉伸）：`,
          `   ffmpeg -i input.jpg -vf "crop=1080:1440:(in_w-1080)/2:0,scale=1080:1440" -y output.jpg`,
          `4. 统一调色使整组图片色调一致`,
          ``,
          `### 最终排版质量标准`,
          `1. 图文排版使用 HTML+CSS 生成（比 ffmpeg 更灵活美观）`,
          `2. 推荐使用方案：生成 HTML 文件 -> 用 playwright 截图 -> 得到高质量图片`,
          `3. CSS 样式参考：`,
          `   - 卡片式布局，圆角 12px，阴影 box-shadow`,
          `   - 正文字号 28-32px，行高 1.8，颜色 #333`,
          `   - 背景使用浅色系（#f8f9fa 或纯白），强调色用主题色`,
          `   - 每页内容不超过 200 字，配图占 40-50% 面积`,
          ``,
        ].join("\n"));
      }
    }

    const prompt = promptParts.filter(Boolean).join("\n");

    const config = await loadConfig();
    let session = wsBridge.getSession(id);
    if (!session) {
      session = await wsBridge.createSession(id, prompt, config.model);
      return c.json({ triggered: true, sessionCreated: true, workId: id, step });
    }

    await wsBridge.sendMessage(id, prompt);
    return c.json({ triggered: true, workId: id, step });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Step trigger error" }, 500);
  }
});

// ── Evaluation helpers ──────────────────────────────────────────────────────

function broadcastPipelineUpdate(workId: string, pipeline: Record<string, PipelineStep>): void {
  if (!wsBridge) return;
  const session = wsBridge.getSession(workId);
  if (!session) return;
  for (const ws of session.browserSockets) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        event: "pipeline_updated",
        data: { workId, pipeline },
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

async function waitForCreatorIdle(workId: string, timeoutMs = 120_000): Promise<void> {
  if (!wsBridge) return;
  const session = wsBridge.getSession(workId);
  if (!session) return;

  // API loop 路径：等当前回合的 promise 结束
  if (session.loopTurnPromise && session.loopState === "running") {
    log("info", "api", "eval_waiting_for_creator", workId, { via: "loop" });
    const start = Date.now();
    await Promise.race([
      session.loopTurnPromise.catch(() => {}),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
    log("info", "api", "eval_creator_idle", workId, { waitedMs: Date.now() - start });
    return;
  }

  // If creator CLI is still running, wait for it to exit
  if (session.cliProcess) {
    log("info", "api", "eval_waiting_for_creator", workId, {});
    const start = Date.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!session.cliProcess || Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      // Listen for the process exit directly if possible
      if (session.cliProcess) {
        session.cliProcess.once("exit", () => {
          // Give a small delay for final messages to flush
          setTimeout(resolve, 1000);
        });
        // Fallback timeout
        setTimeout(check, 500);
      } else {
        resolve();
      }
    });
    log("info", "api", "eval_creator_idle", workId, { waitedMs: Date.now() - start });
  }
}

async function runEvaluation(workId: string, completedStep: string, nextStep?: string): Promise<void> {
  if (!wsBridge) throw new Error("WsBridge not initialized");

  // CRITICAL: Wait for creator agent's CLI process to finish before starting evaluator
  // The creator calls pipeline/advance as a tool use during its turn — we must not
  // start the evaluator until the creator's turn is fully complete to avoid interleaved output.
  await waitForCreatorIdle(workId);

  const work = await getWork(workId);
  if (!work) throw new Error("Work not found");

  const session = wsBridge.ensureSession(workId);
  session.evalStep = completedStep;

  const attempt = (work.evalAttempts?.[completedStep] ?? 0) + 1;

  // Load step history for context
  const stepHistory = await loadStepHistory(workId, completedStep);
  const historyText = (stepHistory as any)?.blocks
    ?.filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n\n")
    .slice(0, 8000) ?? "";

  // Load previous eval results
  const prevResults = await loadAllEvalResults(workId, completedStep);
  const prevResultsText = prevResults.length > 0
    ? prevResults.map(r => `第${r.attempt}轮评审: ${r.verdict}\n问题: ${r.issues.map(i => i.description).join("; ")}\n建议: ${r.suggestions.join("; ")}`).join("\n\n")
    : "";

  // Build evaluator prompt with work directory path
  const workDir = join(dataDir, "works", workId);
  const evalPrompt = buildEvalPrompt(work, completedStep, attempt, historyText, prevResultsText, workDir);

  // Broadcast eval_divider start
  session.messageHistory.push({
    type: "eval_divider" as any,
    text: `评审开始 (第${attempt}轮)`,
    source: "evaluator",
    timestamp: new Date().toISOString(),
  });
  wsBridge.broadcastToBrowsers(workId, {
    event: "eval_divider",
    data: { type: "start", step: completedStep, attempt },
  });

  // Always spawn a fresh evaluator session (no --resume) so it reads the latest files
  // from disk without relying on cached file content from prior eval rounds.
  try {
    // P2-T1:创作者走 API loop 的作品,评审也走 API loop(独立 AgentLoop+视觉路由);
    // CLI 会话(autoMode 批量,P2-T2 前)维持 CLI 评审
    const evalResult = session.loop
      ? await (await import("../agent/evaluator.js")).runApiEvaluator({
          workId,
          step: completedStep,
          evalPrompt,
          config: await loadConfig(),
          workDir,
          session,
          bridge: wsBridge,
        })
      : await wsBridge.spawnEvaluator(session, evalPrompt);
    evalResult.step = completedStep;
    evalResult.attempt = attempt;
    evalResult.timestamp = new Date().toISOString();

    // Save result
    await saveEvalResult(workId, completedStep, attempt, evalResult);

    // Update attempts
    const evalAttempts = { ...(work.evalAttempts ?? {}), [completedStep]: attempt };
    // Also persist evalSessionId
    const evalSessionIds = { ...(work.evalSessionIds ?? {}), [completedStep]: session.evalSessionId ?? "" };
    await storeUpdateWork(workId, { evalAttempts, evalSessionIds } as any);

    if (evalResult.verdict === "pass") {
      // PASS — advance pipeline
      session.messageHistory.push({
        type: "eval_divider" as any,
        text: "评审通过 ✓",
        source: "evaluator",
        timestamp: new Date().toISOString(),
      });
      wsBridge.broadcastToBrowsers(workId, {
        event: "eval_divider",
        data: { type: "end", step: completedStep, verdict: "pass", scores: evalResult.scores },
      });

      // Clean up eval session for this step
      const cleanedEvalSessionIds = { ...evalSessionIds };
      delete cleanedEvalSessionIds[completedStep];

      const freshWork = await getWork(workId);
      if (freshWork) {
        freshWork.pipeline[completedStep].status = "done";
        freshWork.pipeline[completedStep].completedAt = new Date().toISOString();
        // 与 advance 普通路径一致：自动补齐 pending 的前序阶段(可选步骤跳过场景)。
        // active/evaluating 的前序阶段不可能出现——advance 入口守卫已拦截越级推进
        const keys = Object.keys(freshWork.pipeline);
        const idx = keys.indexOf(completedStep);
        for (let i = 0; i < idx; i++) {
          const s = freshWork.pipeline[keys[i]];
          if (s.status === "pending") {
            s.status = "done";
            s.completedAt = s.completedAt ?? new Date().toISOString();
            log("info", "api", "pipeline_auto_complete_skipped", workId, { step: keys[i], via: "eval-pass" });
          }
        }
        if (nextStep && freshWork.pipeline[nextStep]) {
          freshWork.pipeline[nextStep].status = "active";
          freshWork.pipeline[nextStep].startedAt = new Date().toISOString();
        }
        // 评审通过即该步 done：派生状态（最后一步过审时进入 reviewing），
        // 与 pipeline/advance 非评审路径的状态同步逻辑保持一致
        const derivedAfterEval = deriveStatusFromPipeline(freshWork.pipeline, freshWork.status);
        await storeUpdateWork(workId, {
          pipeline: freshWork.pipeline,
          status: derivedAfterEval,
          evalSessionIds: cleanedEvalSessionIds,
          evalAttempts: { ...(freshWork.evalAttempts ?? {}), [completedStep]: 0 },
        } as any);
        broadcastPipelineUpdate(workId, freshWork.pipeline);
        if (derivedAfterEval === "reviewing") {
          notifyWorkSettled(workId, "reviewing");
          // 双产物派生（同 advance 路径，失败不阻塞）
          if (freshWork.dualOutput) {
            deriveDualOutputs(workId).catch((err) =>
              log("error", "api", "dual_output_derive_failed", workId, { error: (err as Error).message }));
          }
        }
      }

      // Persist chat
      saveWorkChat(workId, { blocks: session.messageHistory }).catch(() => {});

      // Auto-resume creator agent to continue with next step
      if (nextStep) {
        const continuePrompt = `评审已通过，pipeline 已自动推进到「${freshWork?.pipeline[nextStep]?.name ?? nextStep}」阶段。请继续执行该阶段的工作。`;
        await wsBridge.sendMessage(workId, continuePrompt);
      }
    } else {
      // FAIL — send feedback to creator agent
      session.messageHistory.push({
        type: "eval_divider" as any,
        text: `评审未通过 ✗ (${evalResult.issues.length}个问题)`,
        source: "evaluator",
        timestamp: new Date().toISOString(),
      });
      wsBridge.broadcastToBrowsers(workId, {
        event: "eval_divider",
        data: { type: "end", step: completedStep, verdict: "fail", scores: evalResult.scores, issues: evalResult.issues },
      });

      // Check iteration limit
      if (attempt >= 3) {
        const freshWork = await getWork(workId);
        if (freshWork) {
          freshWork.pipeline[completedStep].status = "eval_blocked" as any;
          await storeUpdateWork(workId, { pipeline: freshWork.pipeline });
          broadcastPipelineUpdate(workId, freshWork.pipeline);
        }
        // 队列闭环：评审 3 轮不过即卡死，显式出队标 failed 交人工处置 ——
        // 否则队列项停在 running，runner 健康检查会反复恢复（且 startWorkSession
        // 只认 pending/active 步骤，恢复后会跳过被卡的 eval_blocked 步骤）。
        notifyWorkSettled(workId, "failed");
        wsBridge.broadcastToBrowsers(workId, {
          event: "eval_blocked",
          data: { workId, step: completedStep, attempt, result: evalResult },
        });
        saveWorkChat(workId, { blocks: session.messageHistory }).catch(() => {});
        return;
      }

      // Set step back to active
      const freshWork = await getWork(workId);
      if (freshWork) {
        freshWork.pipeline[completedStep].status = "active";
        // 必须重派生 status：f2c 事故中该步曾被评审旁路标 done → status=reviewing,
        // fail 只回退 pipeline 不重算,导致评审页(reviewing)与作品页(active)矛盾
        await storeUpdateWork(workId, {
          pipeline: freshWork.pipeline,
          status: deriveStatusFromPipeline(freshWork.pipeline, freshWork.status),
        });
        broadcastPipelineUpdate(workId, freshWork.pipeline);
      }

      // Inject feedback into creator agent via resume
      const feedbackPrompt = buildFeedbackPrompt(evalResult, attempt);
      await wsBridge.sendMessage(workId, feedbackPrompt);

      // Persist chat
      saveWorkChat(workId, { blocks: session.messageHistory }).catch(() => {});
    }
  } catch (err) {
    log("error", "api", "eval_error", workId, { error: (err as Error).message });
    // On evaluator failure, revert to active
    const freshWork = await getWork(workId);
    if (freshWork) {
      freshWork.pipeline[completedStep].status = "active";
      await storeUpdateWork(workId, { pipeline: freshWork.pipeline });
      broadcastPipelineUpdate(workId, freshWork.pipeline);
    }
  }
}

function buildFeedbackPrompt(evalResult: EvalResult, attempt: number): string {
  const issueList = evalResult.issues
    .map((i, idx) => `${idx + 1}. [${i.severity}] ${i.description}${i.file ? ` (文件: ${i.file})` : ""}`)
    .join("\n");
  const suggestionList = evalResult.suggestions
    .map((s, idx) => `${idx + 1}. ${s}`)
    .join("\n");

  return `## 评审反馈 (第${attempt}轮)

评审未通过，请根据以下反馈修复问题后重新提交：

### 问题列表
${issueList}

### 修改建议
${suggestionList}

请修复以上问题，修复完成后再次调用 pipeline/advance 提交评审。`;
}

function buildEvalPrompt(work: Work, step: string, attempt: number, historyText: string, prevResultsText: string, workDir: string): string {
  const stepName = work.pipeline[step]?.name ?? step;
  const platforms = work.platforms?.join(", ") ?? "未指定";

  return `你是一位严格的内容质量评审专家。你的任务是审查「${work.title}」的「${stepName}」阶段产出。

## 你的角色
- 你是独立的评审者，不是创作者。你的职责是发现问题，而不是赞美。
- AI 存在"自我评价偏差"——倾向于赞美自己的产出。你必须刻意克服这种倾向。
- 使用硬性阈值，不要模糊通过。任何维度低于 6/10 分必须打回。

## 作品信息
- 标题: ${work.title}
- 类型: ${work.type}
- 平台: ${platforms}
- 当前阶段: ${stepName}
- 评审轮次: 第${attempt}轮
- **作品目录: ${workDir}**

## 评审标准
请阅读 skills/content-evaluator/criteria/${step}.md 获取该阶段的详细评审标准。如果文件不存在，请使用通用的内容质量标准进行评审。

## 创作产出摘要
${historyText.slice(0, 6000) || "(无文本产出记录)"}

## 评审指令

**重要：你必须从磁盘重新读取文件的最新内容。不要依赖之前会话中缓存的文件内容。创作者可能已经修改了文件。**

1. 使用 Read 工具从 ${workDir} 目录读取实际文件（必须重新读取，不要使用缓存）
2. 对于图片文件：使用 Read 工具查看图片，评估视觉质量
3. 对于视频文件：使用 ffprobe 检查技术参数（分辨率、时长、编码、音频轨）
4. 根据评审标准逐项评分
5. 输出结构化评审结果

常用文件路径：
- 调研报告: ${workDir}/research/report.md
- 内容方案: ${workDir}/plan/plan.md
- 图片素材: ${workDir}/assets/images/
- 视频素材: ${workDir}/assets/clips/
- 最终输出: ${workDir}/output/

${prevResultsText ? `## 历史评审记录\n${prevResultsText}\n\n请特别关注之前指出的问题是否已修复。**必须重新读取文件确认修复，不要依赖之前的缓存内容。**` : ""}

## 输出格式（必须严格遵循）

在你的分析之后，输出以下 JSON 代码块：

\`\`\`json
{
  "verdict": "pass" 或 "fail",
  "scores": {
    "维度1": 1-10,
    "维度2": 1-10
  },
  "issues": [
    {"severity": "critical/major/minor", "description": "问题描述", "file": "相关文件路径（可选）"}
  ],
  "suggestions": ["修改建议1", "修改建议2"]
}
\`\`\`

规则：
- 任何 critical 问题 → 必须 fail
- 任何维度 < 6/10 → 必须 fail
- 所有维度 ≥ 7/10 且无 critical 问题 → pass`;
}

// POST /api/works/:id/pipeline/advance — agent calls this to advance pipeline
apiRoutes.post("/api/works/:id/pipeline/advance", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json<{ completedStep: string; nextStep?: string }>().catch(() => ({} as any));
    log("info", "api", "pipeline_advance", id, { completedStep: body.completedStep, nextStep: body.nextStep });
    const work = await getWork(id);
    if (!work) return c.json({ error: "Work not found" }, 404);

    const { completedStep, nextStep } = body;
    if (!completedStep) return c.json({ error: "completedStep is required" }, 400);
    if (!work.pipeline[completedStep]) return c.json({ error: `Unknown step: ${completedStep}` }, 400);

    // ── 一致性守卫(2026-08-16 f2c 事故)─────────────────────────────────
    // 守卫1:评审进行中的阶段重复 advance 会绕过评审直接标 done(evaluating 态
    // 会掉进下方普通推进分支)。必须显式拒绝,让 agent 等待评审结果。
    if (work.pipeline[completedStep].status === "evaluating") {
      return c.json({ error: `阶段「${work.pipeline[completedStep].name}」评审进行中，重复推进将绕过评审。请等待评审结果（通过后会自动推进）。` }, 409);
    }
    // 守卫2:越级推进禁令。前序阶段处于 active/evaluating(进行中)时不允许推进
    // 后续阶段——f2c 曾在 assets=active 时推进 assembly 并过审,造成
    // assets=active + assembly=done + status=reviewing 的三视图不一致。
    // pending(未开始)的前序阶段维持原有"自动补齐"语义(兼容可选步骤跳过)。
    {
      const keys = Object.keys(work.pipeline);
      const idx = keys.indexOf(completedStep);
      for (let i = 0; i < idx; i++) {
        const st = work.pipeline[keys[i]].status;
        if (st === "active" || st === "evaluating" || st === "eval_blocked") {
          return c.json({ error: `前序阶段「${work.pipeline[keys[i]].name}」仍在进行中(${st})，禁止越级推进。请先完成并推进该阶段。` }, 400);
        }
      }
    }

    // ── Evaluation gate ─────────────────────────────────────────────────
    // (evaluating 态的重入已被上方守卫1拦截,此处恒为非评审中)
    if (work.evaluationMode) {
      work.pipeline[completedStep].status = "evaluating" as any;
      await storeUpdateWork(id, { pipeline: work.pipeline, status: deriveStatusFromPipeline(work.pipeline, work.status) });
      broadcastPipelineUpdate(id, work.pipeline);

      // Start evaluation asynchronously (don't await — return immediately)
      runEvaluation(id, completedStep, nextStep).catch((err) => {
        log("error", "api", "eval_failed", id, { error: (err as Error).message });
      });

      return c.json({ ok: true, evaluating: true, pipeline: work.pipeline });
    }

    // ── Normal advance (eval off or already passed) ─────────────────────
    if (work.pipeline[completedStep]) {
      work.pipeline[completedStep].status = "done";
      work.pipeline[completedStep].completedAt = new Date().toISOString();
    }

    const stepKeys = Object.keys(work.pipeline);
    const completedIdx = stepKeys.indexOf(completedStep);
    if (completedIdx > 0) {
      for (let i = 0; i < completedIdx; i++) {
        if (work.pipeline[stepKeys[i]].status !== "done") {
          work.pipeline[stepKeys[i]].status = "done";
          work.pipeline[stepKeys[i]].completedAt = work.pipeline[stepKeys[i]].completedAt ?? new Date().toISOString();
          log("info", "api", "pipeline_auto_complete_skipped", id, { step: stepKeys[i] });
        }
      }
    }

    if (nextStep && work.pipeline[nextStep]) {
      work.pipeline[nextStep].status = "active";
      work.pipeline[nextStep].startedAt = new Date().toISOString();

      // Persist step_divider to chat.jsonl so it appears when reloading
      const stepName = work.pipeline[nextStep].name ?? nextStep;
      const dividerBlock = { type: "step_divider", text: stepName, timestamp: new Date().toISOString() };
      const chatFile = join(dataDir, "works", id, "chat.jsonl");
      appendFile(chatFile, JSON.stringify(dividerBlock) + "\n", "utf-8").catch(() => {});

      // Also push to in-memory messageHistory if session exists
      if (wsBridge) {
        const session = wsBridge.getSession(id);
        if (session) {
          session.messageHistory.push(dividerBlock as any);
        }
      }

      // 关键续命：本端点是 agent 回合中通过 curl 调用的——其 CLI 进程在回合
      // 结束后就会退出。后台等待回合完成，然后发送继续指令（--resume 恢复
      // 上下文），驱动流水线自动走完全程，否则作品会停滞在下一阶段开头。
      if (wsBridge) {
        const stepNameForPrompt = stepName;
        (async () => {
          await waitForCreatorIdle(id, 600_000);
          const session = wsBridge.getSession(id);
          // 仅在会话仍可恢复时续命（无会话说明用户未开启过 agent，跳过）
          if (session && (session.cliSessionId || session.messageHistory.length > 0)) {
            await wsBridge.sendMessage(
              id,
              `Pipeline 已推进到「${stepNameForPrompt}」阶段。请继续执行该阶段的工作，完成后再次调用 pipeline/advance 推进到下一阶段。`,
            );
          }
        })().catch((err) => log("error", "api", "pipeline_continue_failed", id, { error: (err as Error).message }));
      }
    }

    // 流水线推进时同步 works.status（此前只写 pipeline_steps，导致卡片状态标签
    // 与进度条长期脱节 —— 2026-07-21 Bug2 根因）。派生是只前进、不覆盖终态的。
    const derivedStatus = deriveStatusFromPipeline(work.pipeline, work.status);
    // 打回重做闭环：流水线再次全部完成（回 reviewing）时清除审核意见，
    // 避免下次会话启动重复注入已处理的旧意见
    const clearReview = derivedStatus === "reviewing" && work.reviewComment ? { reviewComment: "" } : {};
    await storeUpdateWork(id, { pipeline: work.pipeline, status: derivedStatus, ...clearReview });

    // 队列闭环：作品到达终态时通知 runner 出队并启动下一个排队作品。
    // notifyWorkSettled 仅在该作品处于队列 running 状态时生效，未入队作品调用无副作用。
    if (derivedStatus === "reviewing") {
      notifyWorkSettled(id, "reviewing");
      // 双产物派生：dual_output 作品进 reviewing 时异步派生图文产物
      // （文章接线验证 + 小红书卡片渲染）；失败不阻塞 reviewing，仅记日志。
      if (work.dualOutput) {
        deriveDualOutputs(id).catch((err) =>
          log("error", "api", "dual_output_derive_failed", id, { error: (err as Error).message }));
      }
    }
    else if (derivedStatus === "failed") notifyWorkSettled(id, "failed");

    // Memory sync (keep existing logic)
    if (completedStep) {
      loadStepHistory(id, completedStep).then(history => {
        const h = history as { blocks?: { type: string; text: string }[] } | null;
        if (h?.blocks) {
          getWork(id).then(w => {
            syncStepConversation(
              id, w?.title ?? "Untitled", completedStep,
              w?.pipeline?.[completedStep]?.name ?? completedStep, h.blocks!,
            ).catch(() => {});
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    broadcastPipelineUpdate(id, work.pipeline);
    return c.json({ ok: true, pipeline: work.pipeline });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Pipeline advance error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Evaluation API endpoints
// ---------------------------------------------------------------------------

// POST /api/works/:id/eval/toggle
apiRoutes.post("/api/works/:id/eval/toggle", async (c) => {
  const id = c.req.param("id");
  const work = await getWork(id);
  if (!work) return c.json({ error: "Work not found" }, 404);
  const newMode = !(work.evaluationMode ?? false);
  await storeUpdateWork(id, { evaluationMode: newMode } as any);
  return c.json({ ok: true, evaluationMode: newMode });
});

// POST /api/works/:id/eval/force-pass
apiRoutes.post("/api/works/:id/eval/force-pass", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ step: string; nextStep?: string }>().catch(() => ({} as any));
  const work = await getWork(id);
  if (!work) return c.json({ error: "Work not found" }, 404);
  const { step, nextStep } = body;
  if (!step || !["eval_blocked", "evaluating"].includes(work.pipeline[step]?.status as string)) {
    return c.json({ error: "Step not in eval_blocked/evaluating state" }, 400);
  }
  work.pipeline[step].status = "done";
  work.pipeline[step].completedAt = new Date().toISOString();
  if (nextStep && work.pipeline[nextStep]) {
    work.pipeline[nextStep].status = "active";
    work.pipeline[nextStep].startedAt = new Date().toISOString();
  }
  await storeUpdateWork(id, { pipeline: work.pipeline, status: deriveStatusFromPipeline(work.pipeline, work.status) });
  broadcastPipelineUpdate(id, work.pipeline);
  return c.json({ ok: true, pipeline: work.pipeline });
});

// POST /api/works/:id/eval/retry
apiRoutes.post("/api/works/:id/eval/retry", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ step: string; guidance: string }>().catch(() => ({} as any));
  const work = await getWork(id);
  if (!work) return c.json({ error: "Work not found" }, 404);
  const { step, guidance } = body;
  if (!step) return c.json({ error: "step required" }, 400);
  work.pipeline[step].status = "active";
  const evalAttempts = { ...(work.evalAttempts ?? {}), [step]: 0 };
  await storeUpdateWork(id, { pipeline: work.pipeline, evalAttempts, status: deriveStatusFromPipeline(work.pipeline, work.status) } as any);
  broadcastPipelineUpdate(id, work.pipeline);
  if (wsBridge && guidance) {
    await wsBridge.sendMessage(id, `## 用户指导\n\n${guidance}\n\n请根据以上指导修改当前阶段的产出，完成后重新提交。`);
  }
  return c.json({ ok: true });
});

// GET /api/works/:id/eval/results/:step
apiRoutes.get("/api/works/:id/eval/results/:step", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");
  const results = await loadAllEvalResults(id, step);
  return c.json({ results });
});

// ---------------------------------------------------------------------------
// Step History API (persistent execution logs per pipeline step)
// ---------------------------------------------------------------------------

// GET /api/works/:id/steps/:step/history
apiRoutes.get("/api/works/:id/steps/:step/history", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");
  const history = await loadStepHistory(id, step);
  if (!history) return c.json({ error: "No history for this step" }, 404);
  return c.json(history);
});

// POST /api/works/:id/steps/:step/history
apiRoutes.post("/api/works/:id/steps/:step/history", async (c) => {
  const id = c.req.param("id");
  const step = c.req.param("step");
  const body = await c.req.json();
  await saveStepHistory(id, step, body);
  return c.json({ saved: true });
});

// GET /api/works/:id/chat — load full conversation
apiRoutes.get("/api/works/:id/chat", async (c) => {
  const id = c.req.param("id");
  try {
    const { loadWorkChat } = await import("../work-store.js");
    const chat = await loadWorkChat(id);
    if (!chat) return c.json({ error: "No chat history" }, 404);
    return c.json(chat);
  } catch {
    return c.json({ error: "No chat history" }, 404);
  }
});

// PUT /api/works/:id/chat — save full conversation
apiRoutes.put("/api/works/:id/chat", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  try {
    const { saveWorkChat } = await import("../work-store.js");
    await saveWorkChat(id, body);
    return c.json({ saved: true });
  } catch {
    return c.json({ error: "Save failed" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Logs API — structured log viewer
// ---------------------------------------------------------------------------

// GET /api/logs — query structured logs
apiRoutes.get("/api/logs", async (c) => {
  const date = c.req.query("date");
  const workId = c.req.query("workId");
  const source = c.req.query("source") as any;
  const level = c.req.query("level") as any;
  const limit = parseInt(c.req.query("limit") ?? "200", 10);

  const entries = await readLogs({ date, workId, source, level, limit });
  return c.json({ entries, count: entries.length });
});

// GET /api/logs/work/:id — all logs for a specific work
apiRoutes.get("/api/logs/work/:id", async (c) => {
  const workId = c.req.param("id");
  const entries = await readLogs({ workId, limit: 500 });
  return c.json({ entries, count: entries.length });
});

// ---------------------------------------------------------------------------
// Test Runner API
// ---------------------------------------------------------------------------

// POST /api/test/run — trigger a full pipeline test run
apiRoutes.post("/api/test/run", async (c) => {
  if (!wsBridge) return c.json({ error: "WsBridge not initialized" }, 503);

  try {
    const body = await c.req.json<RunConfig>();
    if (!body.type || !body.platform) {
      return c.json({ error: "type and platform are required" }, 400);
    }

    // Start run in background (don't await the full pipeline)
    const resultPromise = runPipeline(wsBridge, body);

    // Small delay to let runner initialize and create the work
    await new Promise(r => setTimeout(r, 500));

    // Find the active run
    const runs = await listRuns();
    const activeRun = runs.find(r => r.status === "running");

    if (activeRun) {
      // After pipeline completes, run evaluation (fire and forget)
      resultPromise.then(async (result) => {
        try {
          const evaluation = await evaluateWork(result.workId, body.type);
          result.evaluation = evaluation;
          // Re-save with evaluation
          const { writeFile, mkdir } = await import("node:fs/promises");
          const dir = join(homedir(), ".autoviral", "test-runs", result.runId);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2), "utf-8");
          await writeFile(join(dir, "evaluation.json"), JSON.stringify(evaluation, null, 2), "utf-8");
        } catch { /* evaluation failure is non-blocking */ }
      }).catch(() => {});

      return c.json({ runId: activeRun.runId, workId: activeRun.workId, status: "running" });
    }

    return c.json({ error: "Failed to start run" }, 500);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Run failed" }, 500);
  }
});

// GET /api/test/status/:runId — query run status
apiRoutes.get("/api/test/status/:runId", async (c) => {
  const runId = c.req.param("runId");
  const run = getRunStatus(runId) ?? await getRunReport(runId);
  if (!run) return c.json({ error: "Run not found" }, 404);
  return c.json(run);
});

// GET /api/test/runs — list all test runs
apiRoutes.get("/api/test/runs", async (c) => {
  const runs = await listRuns();
  return c.json({ runs });
});

// GET /api/test/runs/:runId/report — full report
apiRoutes.get("/api/test/runs/:runId/report", async (c) => {
  const runId = c.req.param("runId");
  const report = await getRunReport(runId);
  if (!report) return c.json({ error: "Report not found" }, 404);
  return c.json(report);
});

// ---------------------------------------------------------------------------
// Memory API (EverMemOS integration)
// ---------------------------------------------------------------------------

let _memoryClient: MemoryClient | null | undefined;
async function getMemoryClient(): Promise<MemoryClient | null> {
  if (_memoryClient === undefined) {
    _memoryClient = await MemoryClient.fromConfig();
  }
  return _memoryClient;
}

// GET /api/memory/search?q=...&method=hybrid&topK=10
apiRoutes.get("/api/memory/search", async (c) => {
  const client = await getMemoryClient();
  if (!client) return c.json({ error: "Memory not configured (missing apiKey)" }, 503);
  const q = c.req.query("q") ?? "";
  if (!q) return c.json({ error: "Missing query parameter ?q=" }, 400);
  const method = (c.req.query("method") ?? "hybrid") as "keyword" | "vector" | "hybrid" | "agentic";
  const topK = parseInt(c.req.query("topK") ?? "10", 10);
  const result = await client.search(q, { method, topK });
  return c.json(result);
});

// GET /api/memory/profile
apiRoutes.get("/api/memory/profile", async (c) => {
  const client = await getMemoryClient();
  if (!client) return c.json({ error: "Memory not configured (missing apiKey)" }, 503);
  const [style, rules] = await Promise.all([
    client.search("我的内容风格 创作偏好 个人特征", { method: "vector", topK: 10, memoryTypes: ["core", "profile"] }),
    client.search("平台规则 算法推荐 发布技巧", { method: "keyword", topK: 10 }),
  ]);
  return c.json({
    profiles: style.profiles,
    styleMemories: style.memories,
    platformRules: rules.memories,
  });
});

// GET /api/memory/context/:workId
apiRoutes.get("/api/memory/context/:workId", async (c) => {
  const client = await getMemoryClient();
  if (!client) return c.json({ error: "Memory not configured (missing apiKey)" }, 503);
  const workId = c.req.param("workId");
  const work = await getWork(workId);
  if (!work) return c.json({ error: "Work not found" }, 404);
  const topic = work.topicHint ?? work.title;
  const firstPlatform = work.platforms?.[0];
  const platform = typeof firstPlatform === "string" ? firstPlatform : (firstPlatform as any)?.platform ?? "通用";
  const context = await client.buildContext(topic, platform);
  return c.json({ workId, topic, platform, context });
});

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

apiRoutes.get("/api/topics", async (c) => {
  const platform = c.req.query("platform");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const topics = listTopics(platform, limit);
  return c.json({ topics });
});

apiRoutes.get("/api/topics/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const topic = getTopic(id);
  if (!topic) return c.json({ error: "Topic not found" }, 404);
  return c.json(topic);
});

// DELETE /api/topics/:id — remove a topic
apiRoutes.delete("/api/topics/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const ok = deleteTopic(id);
  if (!ok) return c.json({ error: "Topic not found" }, 404);
  return c.json({ deleted: true });
});

// POST /api/topics — manually create a topic (bypass AI collection)
apiRoutes.post("/api/topics", async (c) => {
  const body = await c.req.json<{
    title: string;
    description?: string;
    platform?: string;
    category?: string;
    tags?: string[];
    content_angles?: string[];
    emotion_type?: string;
    heat?: number;
    competition?: string;
    opportunity?: string;
  }>();
  if (!body.title) return c.json({ error: "title is required" }, 400);
  const { createTopic } = await import("../db/topics-repo.js");
  const topic = createTopic({
    title: body.title,
    description: body.description ?? "",
    platform: body.platform,
    category: body.category,
    tags: body.tags ?? [],
    content_angles: body.content_angles ?? [],
    emotion_type: body.emotion_type,
    heat: body.heat ?? 0,
    competition: body.competition ?? "中",
    opportunity: body.opportunity ?? "",
    status: "selected",
  });
  return c.json(topic, 201);
});

// Topics are collected globally (independent of accounts) during trend research.
// Account association only happens here — when a topic is converted to a work,
// the optional accountId links it to a specific account's tone_profile for AI generation.
apiRoutes.post("/api/topics/:id/convert", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const topic = getTopic(id);
  if (!topic) return c.json({ error: "Topic not found" }, 404);

  const body = await c.req.json<{ platforms?: string[]; type?: "short-video" | "image-text"; accountId?: string }>().catch(() => ({} as any));
  const platforms = body.platforms ?? ["douyin", "xiaohongshu"];
  const type = body.type ?? "short-video";
  const accountId = (body as any).accountId as string | undefined;
  const account = accountId ? getAccount(accountId) : undefined;
  const genOpts = { toneProfile: account?.tone_profile };

  const work = await createWork({
    title: topic.title,
    type,
    contentCategory: topic.emotion_type as any,
    platforms,
    accountId: accountId,
    topicHint: [topic.title, topic.description, `情绪：${topic.emotion_type}/${topic.emotion_subtype}`, `标签：${topic.tags.join(",")}`].filter(Boolean).join("\n"),
  });

  const platform = platforms[0] ?? "douyin";
  const article = generateArticleFromTopic(topic, platform, genOpts);
  const script = article.then((a) => generateScriptFromArticle(a, 180, genOpts));

  const [a, s] = await Promise.all([article, script]);
  try {
    createArticle({ work_id: work.id, topic_id: topic.id, title: a.title, content: a.content, platform, status: "ready" });
    createScript({ work_id: work.id, content: s as unknown as Record<string, unknown>, duration: s.duration, status: "ready" });
    updateTopic(topic.id, { status: "converted", work_id: work.id });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "DB write failed" }, 500);
  }

  // Auto-start the pipeline: mark research as done (we already have the article+script)
  // and trigger the next step (plan)
  try {
    const workObj = await getWork(work.id);
    if (workObj) {
      // Mark research step as done since we have the article+script already
      const pipeline = workObj.pipeline;
      if (pipeline["research"]) {
        pipeline["research"].status = "done";
        pipeline["research"].completedAt = new Date().toISOString();
        pipeline["research"].note = "Auto-generated from topic conversion";
      }
      // Mark plan step as active
      if (pipeline["plan"]) {
        pipeline["plan"].status = "active";
        pipeline["plan"].startedAt = new Date().toISOString();
      }
      await storeUpdateWork(work.id, { status: "planning", pipeline });
    }
  } catch (err) {
    console.error("[convert] Failed to auto-start pipeline:", err);
  }

  return c.json({ workId: work.id, autoStarted: true });
});

// POST /api/topics/batch-convert - Convert multiple topics to works with auto-pipeline (async)
//
// 立即返回 jobId，后台串行处理：创建作品 → 生成文章/脚本 → 入队（由串行 runner
// 启动 agent 会话，有模板/数字人时全自动走完流水线）。前端轮询 batch-status 获取逐项进度。
interface BatchConvertItem {
  topicId: number;
  title?: string;
  workId?: string;
  /** queued → creating → generating → queued（已入作品队列）/ done / error */
  stage: string;
  error?: string;
  /** item 级自动重试计数（配合 LLM 层重试，应对会话启动失败等非 LLM 错误） */
  retryCount?: number;
}
interface BatchConvertJob {
  id: string;
  status: "running" | "done";
  autoPipeline: boolean;
  items: BatchConvertItem[];
  startedAt: number;
  finishedAt?: number;
}
const batchConvertJobs = new Map<string, BatchConvertJob>();

/** 批量创作的控制条件（全自动模式下决定视频形态） */
interface BatchConvertOptions {
  templateId?: string;
  digitalHumanId?: string;
  platforms?: string[];
  /** video+image-text = 短视频作品 + 双产物标记（works.dual_output=1） */
  type?: "short-video" | "video+image-text" | "image-text";
  /** 视频时长（秒），默认 180 */
  duration?: number;
  /** 视频风格：hot_comment | knowledge | industry | insight */
  contentForm?: string;
  /** 素材样式：search | ai-generate */
  videoSource?: string;
  /** 素材搜索关键词（缺省用选题标题） */
  videoSearchQuery?: string;
  /** 配音风格（MiniMax voice_id / 克隆音色 ID） */
  voiceStyle?: string;
  /** 配音模式：克隆音色 | AI 音色 */
  voiceMode?: "cloned" | "ai";
  /** 素材形态：video-mix | image-carousel | slides | auto */
  assetForm?: string;
  /** 素材来源：stock | ai | user | auto */
  assetSource?: string;
  /** 成本档：eco（禁 AI 视频生成）| premium */
  assetBudget?: string;
  /** 质量评审闸门：默认开（true），显式传 false 关闭 */
  evaluationMode?: boolean;
}

const CONTENT_FORM_LABELS: Record<string, string> = {
  hot_comment: "热点评述",
  knowledge: "知识科普",
  industry: "行业洞察",
  insight: "观点输出",
};

/** 素材三维合法值（非法值静默丢弃，不阻断批量任务） */
const ASSET_FORMS = new Set(["video-mix", "image-carousel", "slides", "auto"]);
const ASSET_SOURCES = new Set(["stock", "ai", "user", "auto", "smart"]);
const ASSET_BUDGETS = new Set(["eco", "premium"]);

const ASSET_FORM_LABELS: Record<string, string> = {
  "video-mix": "以真实视频混剪为主",
  "image-carousel": "图片轮播配讲解",
  slides: "AI 生成讲解幻灯片",
  auto: "不限制",
};
const ASSET_SOURCE_LABELS: Record<string, string> = {
  stock: "仅用素材库真实素材",
  ai: "仅 AI 生成",
  user: "仅用用户指定素材",
  auto: "不限制",
  smart: "精品混合(按镜头内容自动路由:数据→程序化素材、氛围→AI、真实画面→素材库)",
};
const ASSET_BUDGET_LABELS: Record<string, string> = {
  eco: "仅使用本地 H3 生成视频（provider=local-h3），禁用一切云端视频生成（即梦/Seedance/Dreamina 均不可用）。若 local-h3 不可用（AutoDL 实例离线），不得改用云端视频，应阻塞并显著提醒用户开机 AutoDL 实例",
  premium: "不限制",
};

function sanitizeAssetForm(v?: string): string | undefined { return v && ASSET_FORMS.has(v) ? v : undefined; }
function sanitizeAssetSource(v?: string): string | undefined { return v && ASSET_SOURCES.has(v) ? v : undefined; }
function sanitizeAssetBudget(v?: string): string | undefined { return v && ASSET_BUDGETS.has(v) ? v : undefined; }

/**
 * 模板契约段落（2026-08-13 模板修复）:作品绑定模板时注入会话 prompt。
 * 此前只注入 templateId 字符串,agent 从不知道模板内容,导致"选了模板但没按模板呈现"。
 * 边界(用户确认):模板只约束视觉呈现(版式/配色/动效/图层),不约束选题/文案/素材内容。
 */
export function buildTemplateSection(templateId?: string): string {
  if (!templateId) return "";
  const t = getTemplate(templateId);
  if (!t) return `模板: ${templateId}(⚠️ 模板不存在,按无模板流程执行)`;

  const lines: string[] = [];
  lines.push(`模板契约(视觉呈现必须严格遵守;选题、文案、素材内容保持创作自由):`);
  lines.push(`- 模板: ${t.name}(id: ${t.id}, 类型: ${t.kind === "image-text" ? "图文" : "视频"})`);

  if (t.kind === "image-text") {
    // 图文模板:layers 里是 cover/content 两条 LayoutSpec
    for (const layer of t.layers ?? []) {
      const l = layer as Record<string, unknown>;
      if (l.type === "image-text-layout") {
        const cs = (l.colorScheme ?? {}) as Record<string, string>;
        lines.push(
          `- ${l.page === "cover" ? "封面" : "内容页"}版式: ${l.layout} | 字体 ${l.font} 主标题 ${l.fontSize}px` +
          ` | 配色 底${cs.background} 主${cs.primary} 文${cs.text} 缀${cs.accent}` +
          ` | 装饰 ${(l.decorations as string[] | undefined)?.join("/") || "无"}`,
        );
      }
    }
    lines.push(`- 执行规则: 图文产物由系统在派生阶段自动套用此模板版式,无需手动渲染;文案内容按策划自由创作`);
  } else {
    const canvas = t.canvas as unknown as Record<string, unknown> | undefined;
    lines.push(`- 画布: ${canvas?.width ?? "?"}x${canvas?.height ?? "?"}@${canvas?.fps ?? "?"}fps`);
    if (t.variables?.length) {
      lines.push(`- 变量槽位(渲染时必须填充):`);
      for (const v of t.variables) {
        lines.push(`  - {{${v.name}}} (${v.type})${v.label ? ` ${v.label}` : ""}${v.default !== undefined ? ` 默认:${v.default}` : ""}`);
      }
    }
    const layers = (t.layers ?? []) as Record<string, unknown>[];
    if (layers.length) {
      lines.push(`- 结构摘要(${layers.length} 层):`);
      for (const l of layers.slice(0, 20)) {
        const desc = String(l.content ?? l.source ?? l.text ?? "").slice(0, 40);
        lines.push(`  - ${l.id} [${l.type}] t=${l.start ?? 0}s+${l.duration ?? "?"}s${desc ? ` — ${desc}` : ""}`);
      }
    }
    lines.push(`- 执行规则:`);
    lines.push(`  1. 模板覆盖"文字信息卡"类镜头(标题卡/章节卡/要点卡/总结卡)：这些镜头的版式/配色/动效严格按模板,禁止自由发挥`);
    lines.push(`  2. 模板管不了也不该管的镜头,按素材路由走专门管线并独立渲染：数据→/api/assets/chart|data-card；结构/流程/逻辑→/api/assets/code-scene(程序化动画,优先于静态卡)；原文证据→snapshot-card；实拍/氛围→Pexels或AI生成。这些分段与模板分段按分镜顺序 ffmpeg concat 混排——混排是标准做法,不算"自由合成"`);
    lines.push(`  3. 模板分段必须调用模板渲染引擎 POST /api/works/{workId}/render 产出,把素材映射进变量槽位；混排成片的视觉统一靠全片统一调色(见合成阶段调色规范),而不是全片只用模板`);
    lines.push(`  4. 完整模板 JSON: curl -s http://localhost:3271/api/templates/${t.id}`);
  }
  return lines.join("\n");
}

/** 素材三维 → prompt 约束段（三维全空时返回空串）；hasDigitalHuman=false 时口播路由禁用数字人 */
function buildAssetConstraintSection(assetForm?: string, assetSource?: string, assetBudget?: string, hasDigitalHuman?: boolean): string {  const lines: string[] = [];
  if (assetForm) lines.push(`- 素材形态: ${ASSET_FORM_LABELS[assetForm] ?? assetForm}`);
  if (assetSource) lines.push(`- 素材来源: ${ASSET_SOURCE_LABELS[assetSource] ?? assetSource}`);
  if (assetBudget) lines.push(`- 成本档: ${ASSET_BUDGET_LABELS[assetBudget] ?? assetBudget}`);
  // 程序化精确素材铁律(2026-08-14):任何获取策略下都生效。
  // 程序化素材本地程序化渲染(零生成成本、秒级出图),不属于"外部素材来源",
  // 因此 stock/user 等受限策略下同样允许且必须使用——它替代的是"AI 生图伪造数据"这条死路。
  lines.push(
    `- 程序化素材铁律(无条件生效): 凡涉及精确数据(数值/对比/趋势/占比)、政策文件/新闻原文、结构关系的镜头,禁止 AI 生图(数字必错、文字乱码)。` +
      `必须调用本地程序化素材 API: 数据图表 POST /api/assets/data-card(简单数据)或 /api/assets/chart(复杂 ECharts);` +
      `政策/网页原文快照 POST /api/assets/snapshot-card;图标 GET /api/assets/icons。主题配色须与作品模板一致,数据来源必须署名。` +
      `快照卡必须传 highlights 红框标注关键条款/段落(禁止整页裸截,截正文区避开广告与侧栏);` +
      `图表数值与旁白口径必须一致——旁白说"超六成",图表须标">60%"或"超60%",禁止写成精确值 60%;` +
      `结构/流程/逻辑镜头调用 POST /api/assets/code-scene 生成程序化动画(三模板:structure-growth/flow-steps/logic-chain,先 GET /api/assets/code-scene/templates 查参数);`,
  );
  // smart 精品混合:按镜头内容路由到最优来源,是"出品即精品"的默认策略
  if (assetSource === "smart") {
    lines.push(
      `- 镜头路由(smart): 数据/对比/趋势→程序化素材(data-card/chart);政策/文件原文→snapshot-card;` +
        `氛围/场景感画面→AI 生图后 i2v;真实事件/实拍画面→素材库搜索(优先 Pexels 竖版视频),搜不到再 AI 生成;` +
        (hasDigitalHuman === false
          ? `口播/讲解内容→配音+字幕卡/图解呈现(本作品未选数字人,禁用数字人镜头)`
          : `口播/讲解人→数字人或 H3 t2v(dialogue)`),
    );
  }
  // AI 生成来源下的 H3 本地生成路由规则（MiniMax H3,成本约 ¥0.13/条,远低于云端)
  if (assetSource === "ai" || assetSource === "auto" || assetSource === "smart") {
    lines.push(
      `- 视频生成路由: AI 生成的视频镜头优先走本地 H3(provider=local-h3,调 /api/generate/video 时显式传 provider:"local-h3")。` +
        `broll 氛围/空镜、narration 解说配图、dialogue 对白播报等常规镜头一律用 H3;` +
        (assetBudget === "eco"
          ? `eco 档下 hero 精品镜头也用 H3;H3 离线时不得改用云端,阻塞并提醒用户开机 AutoDL 实例`
          : `仅 hero 精品镜头(海报级画面)可用云端 Seedance/即梦;H3 离线时常规镜头可降级: broll 用素材库搜索补位,其余用云端 provider`),
    );
  }
  // 口播类长视频的质量底线:纯图片轮播观感廉价,video-mix/auto 下必须以真实视频混剪为主
  if (assetForm === "video-mix" || assetForm === "auto" || !assetForm) {
    lines.push(`- 质量底线: 超过 60 秒的口播类视频必须以真实视频混剪为主(优先 Pexels 竖版视频,type=video 搜索),禁止全片纯图片轮播+Ken Burns;图片仅作为信息补充(数据卡/示意图),占比不超过 30%`);
  }
  return lines.length ? `素材约束:\n${lines.join("\n")}` : "";
}

async function runBatchConvert(
  job: BatchConvertJob,
  body: BatchConvertOptions,
): Promise<void> {
  const platforms = body.platforms ?? ["douyin", "xiaohongshu"];
  const type = body.type ?? "short-video";
  // video+image-text：作品仍建 short-video（先走短视频流水线），dual_output=1 标记双产物
  const dualOutput = type === "video+image-text";
  const workType: "short-video" | "image-text" = dualOutput ? "short-video" : type;
  const duration = body.duration && body.duration > 0 ? body.duration : 180;
  const assetForm = workType === "short-video" ? sanitizeAssetForm(body.assetForm) : undefined;
  const assetSource = workType === "short-video" ? sanitizeAssetSource(body.assetSource) : undefined;
  const assetBudget = workType === "short-video" ? sanitizeAssetBudget(body.assetBudget) : undefined;

  // 串行队列：一次只处理一个选题。
  // 2026-07-21 Bug3 根因：并发 2 条链同时 spawn `claude -p`，LLM 订阅并发
  // 限流使第二个任务直接失败。串行 + llm-json 层指数退避重试 + item 级
  // 失败重排（各 1 次）替代并发，换取批量任务的总体成功率。
  const CONCURRENCY = 1;
  const queue = [...job.items];

  // 视频制作控制条件 → 注入 topicHint，随 startWorkSession 的 prompt 直达 agent
  const controlLines: string[] = [];
  if (workType === "short-video") {
    controlLines.push(`视频时长: 约${duration}秒`);
    if (body.contentForm) controlLines.push(`视频风格: ${CONTENT_FORM_LABELS[body.contentForm] ?? body.contentForm}`);
    // 旧 videoSource 字段的"素材样式"行仅在没有新 assetSource 时输出,避免与素材约束段语义冲突
    if (body.videoSource && !assetSource) controlLines.push(`素材样式: ${body.videoSource === "ai-generate" ? "AI 生成素材" : "素材库搜索"}`);
    if (dualOutput) controlLines.push(`双产物: 本作品需同时产出短视频与图文（内容一致、素材共用），视频合成完成后派生图文产物`);
    const assetSection = buildAssetConstraintSection(assetForm, assetSource, assetBudget, !!body.digitalHumanId);
    if (assetSection) controlLines.push(assetSection);
    if (body.voiceStyle) {
      const modeLabel = body.voiceMode === "cloned" ? "克隆真人音色" : "AI 合成音色";
      controlLines.push(`配音风格: 使用${modeLabel} voice_id="${body.voiceStyle}"（配音时必须使用该音色，调用 /api/generate/audio 时 voice 参数传该值）`);
    }
  }

  const processItem = async (item: BatchConvertItem): Promise<void> => {
    try {
      const topic = getTopic(item.topicId);
      if (!topic) { item.stage = "error"; item.error = "选题不存在"; return; }
      item.title = topic.title;

      // 幂等续跑：重排的 item 已持有 workId 时，跳过创建/文案阶段，直接重试启动
      if (!item.workId) {
        item.stage = "creating";
        const work = await createWork({
          title: topic.title,
          type: workType,
          contentCategory: topic.emotion_type as any,
          contentForm: body.contentForm,
          videoSource: workType === "short-video" ? (body.videoSource as any) : undefined,
          videoSearchQuery: workType === "short-video" && body.videoSource === "search"
            ? (body.videoSearchQuery ?? topic.title)
            : undefined,
          platforms,
          topicHint: [topic.title, topic.description, `情绪：${topic.emotion_type}/${topic.emotion_subtype}`, `标签：${topic.tags.join(",")}`, ...controlLines].filter(Boolean).join("\n"),
          templateId: body.templateId,
          digitalHumanId: body.digitalHumanId,
          voiceId: body.voiceStyle,
          assetForm: assetForm as any,
          assetSource: assetSource as any,
          assetBudget: assetBudget as any,
          dualOutput,
          evaluationMode: body.evaluationMode ?? true,
          // 批量按钮 = 全自动模式唯一开关(2026-08-16 用户决策)
          autoMode: true,
        });
        item.workId = work.id;

        item.stage = "generating";
        const platform = platforms[0] ?? "douyin";
        const scriptCfg = await loadConfig();
        const scriptModel = scriptCfg.scriptModel ?? "opus";
        const article = await generateArticleFromTopic(topic, platform, { model: scriptModel });
        const script = await generateScriptFromArticle(article, duration, { model: scriptModel });

        try {
          createArticle({ work_id: work.id, topic_id: topic.id, title: article.title, content: article.content, platform, status: "ready" });
          createScript({ work_id: work.id, content: script as unknown as Record<string, unknown>, duration: script.duration, status: "ready" });
          updateTopic(topic.id, { status: "converted", work_id: work.id });
        } catch (err) {
          console.error(`[batch-convert] DB write failed for topic ${item.topicId}:`, err);
        }

        // 调研产物落盘(2026-08-14):批量模式 research 自动完成但磁盘无报告,
        // 下游分镜/评审无据可依。把选题数据+文案+脚本写入 research/report.md
        try {
          const { mkdir: mkResearchDir, writeFile: writeResearchFile } = await import("node:fs/promises");
          const researchDir = join(dataDir, "works", work.id, "research");
          await mkResearchDir(researchDir, { recursive: true });
          const topicAny = topic as unknown as Record<string, unknown>;
          const report = [
            `# 调研报告:${topic.title}`,
            ``,
            `> 本报告由批量转换流程自动生成(选题趋势数据 + LLM 文案/脚本),供分镜/素材/评审阶段取数与核实。`,
            ``,
            `## 选题数据`,
            `- 情绪: ${(topicAny.emotion_type as string) ?? "-"}`,
            `- 标签: ${((topicAny.tags as string[]) ?? []).join(", ") || "-"}`,
            topicAny.summary ? `- 摘要: ${topicAny.summary}` : "",
            Array.isArray(topicAny.content_angles) && topicAny.content_angles.length ? `- 内容角度: ${(topicAny.content_angles as string[]).join(";")}` : "",
            ``,
            `## 文案(article)`,
            `### ${article.title}`,
            article.content,
            ``,
            `## 脚本(script, 约${script.duration}s)`,
            "```json",
            JSON.stringify(script, null, 2).slice(0, 4000),
            "```",
          ].filter((l) => l !== "").join("\n");
          await writeResearchFile(join(researchDir, "report.md"), report, "utf-8");
        } catch (err) {
          console.warn(`[batch-convert] research report write failed for ${work.id}:`, err);
        }

        // Mark research as done, plan as active
        try {
          const workObj = await getWork(work.id);
          if (workObj) {
            const pipeline = workObj.pipeline;
            if (pipeline["research"]) {
              pipeline["research"].status = "done";
              pipeline["research"].completedAt = new Date().toISOString();
              pipeline["research"].note = "Auto-generated from batch conversion";
            }
            if (pipeline["plan"]) {
              pipeline["plan"].status = "active";
              pipeline["plan"].startedAt = new Date().toISOString();
            }
            await storeUpdateWork(work.id, { status: "planning", pipeline });
          }
        } catch (err) {
          console.error(`[batch-convert] Failed to auto-start pipeline for topic ${item.topicId}:`, err);
        }
      }

      // 全自动模式：入队等待串行 runner 启动 agent 会话（不再直接 startWorkSession ——
      // 并发 spawn 多个 claude 进程会触发订阅限流，串行启动由 runner 统一保证）。
      // item.stage 置回 "queued"：语义为"已入作品队列，等待 runner 调度"。
      if (job.autoPipeline) {
        enqueueWork(item.workId!);
        item.stage = "queued";
      } else {
        item.stage = "done";
      }
    } catch (err) {
      // item 级自动重试（1 次）：LLM 层已有指数退避重试，这里兜底建作品、
      // 文案生成、DB 抖动等非 LLM 瞬态错误。重排回队尾，不阻塞其他选题。
      if ((item.retryCount ?? 0) < 1) {
        item.retryCount = (item.retryCount ?? 0) + 1;
        item.stage = "queued";
        item.error = undefined;
        console.warn(`[batch-convert] topic ${item.topicId} failed (attempt ${item.retryCount}), re-queued:`, err);
        queue.push(item);
        return;
      }
      item.stage = "error";
      item.error = err instanceof Error ? err.message : String(err);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await processItem(item);
    }
  });
  await Promise.all(workers);

  job.status = "done";
  job.finishedAt = Date.now();
}

apiRoutes.post("/api/topics/batch-convert", async (c) => {
  const body = await c.req.json<{
    topicIds: number[];
    templateId?: string;
    digitalHumanId?: string;
    platforms?: string[];
    type?: "short-video" | "video+image-text" | "image-text";
    autoPipeline?: boolean;
    duration?: number;
    contentForm?: string;
    videoSource?: string;
    videoSearchQuery?: string;
    voiceStyle?: string;
    voiceMode?: "cloned" | "ai";
    assetForm?: string;
    assetSource?: string;
    assetBudget?: string;
  }>().catch(() => ({ topicIds: [] } as any));

  if (!body.topicIds?.length) return c.json({ error: "topicIds is required" }, 400);
  if (body.voiceStyle && !isSafeExternalVoiceId(body.voiceStyle)) {
    return c.json({ error: "voiceStyle 非法：不允许路径字符" }, 400);
  }

  const jobId = "batch_" + Date.now();
  const job: BatchConvertJob = {
    id: jobId,
    status: "running",
    autoPipeline: body.autoPipeline !== false,
    items: body.topicIds.map((topicId: number) => ({ topicId, stage: "queued" })),
    startedAt: Date.now(),
  };
  batchConvertJobs.set(jobId, job);

  // fire-and-forget：后台串行执行，前端轮询进度
  runBatchConvert(job, body).catch((err) => {
    job.status = "done";
    console.error("[batch-convert] job crashed:", err);
  });

  return c.json({ jobId, count: job.items.length });
});

// GET /api/topics/batch-status/:jobId - poll batch conversion progress
apiRoutes.get("/api/topics/batch-status/:jobId", (c) => {
  const job = batchConvertJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// GET /api/digital-humans/avatars/list - simple list for dropdowns
// (already exists above, but add a lightweight version for batch UI)

// ---------------------------------------------------------------------------
// Manual trend collection trigger
// ---------------------------------------------------------------------------

// In-memory tracking for async trend collection jobs
interface TrendJobPlatform { platform: string; status: "pending" | "running" | "done" | "error"; count?: number; error?: string }
interface TrendJob {
  status: string;
  platform: string;
  interests: string[];
  collected: number;
  error?: string;
  startedAt: number;
  topN?: number;
  platformsProgress?: TrendJobPlatform[];
}
const trendJobs = new Map<string, TrendJob>();
/** 最近一次任务 ID（供 /active 恢复查询，页面刷新/切换后不丢状态） */
let lastTrendJobId: string | null = null;

// POST /api/trends/collect - start async trend collection (returns job immediately)
apiRoutes.post("/api/trends/collect", async (c) => {
  const config = await loadConfig();
  const body = await c.req.json<{ platform?: string; interests?: string[]; accountId?: string; topN?: number }>().catch(() => ({}));
  // Collect across ALL configured platforms, not just one
  const allPlatforms = config.research?.platforms?.length
    ? config.research.platforms
    : ["douyin", "xiaohongshu", "bilibili", "zhihu", "kuaishou", "channels", "wechat_mp"];
  // If user specified a single platform in the request, use just that one
  const platforms = (body as any).platform
    ? [(body as any).platform]
    : allPlatforms;
  const reqInterests = (body as any).interests ?? config.interests ?? [];
  const interests = Array.isArray(reqInterests) ? reqInterests : [];
  const accountId = (body as any).accountId as string | undefined;
  const account = accountId ? getAccount(accountId) : undefined;
  // TopN：请求优先，其次配置里的 research.topN
  const topN = Number((body as any).topN) > 0 ? Number((body as any).topN) : (config.research?.topN ?? 0);

  const jobId = "trend_" + Date.now();
  trendJobs.set(jobId, { status: "running", platform: platforms.join(","), interests, collected: 0, startedAt: Date.now(), topN });
  lastTrendJobId = jobId;

  // Run collection asynchronously (fire and forget)
  collectTrends(platforms, interests, account?.tone_profile, {
    topN,
    onProgress: (progress) => {
      const job = trendJobs.get(jobId);
      if (job) job.platformsProgress = progress;
    },
  })
    .then((results) => {
      const total = results.reduce((sum, r) => sum + r.topics.length, 0);
      const job = trendJobs.get(jobId);
      if (job) { job.status = "done"; job.collected = total; }
    })
    .catch((err) => {
      const job = trendJobs.get(jobId);
      if (job) { job.status = "error"; job.error = err instanceof Error ? err.message : String(err); }
    });

  return c.json({ jobId, status: "running", platform: platforms.join(","), message: "调研已启动，请稍后查看结果" });
});

// GET /api/trends/collect/active - 最近一次的调研任务（页面切换/刷新后恢复状态用）
apiRoutes.get("/api/trends/collect/active", (c) => {
  const job = lastTrendJobId ? trendJobs.get(lastTrendJobId) : undefined;
  if (!job || !lastTrendJobId) return c.json({ job: null });
  if (Date.now() - job.startedAt > 3600000) return c.json({ job: null }); // 1 小时后不再恢复
  return c.json({ job: { jobId: lastTrendJobId, ...job } });
});

// GET /api/trends/collect/status/:jobId - poll async collection status
apiRoutes.get("/api/trends/collect/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = trendJobs.get(jobId);
  if (!job) return c.json({ error: "Job not found" }, 404);
  // Auto-cleanup jobs older than 60 minutes（全平台调研可能跑 10~20 分钟，10 分钟会误判过期）
  if (Date.now() - job.startedAt > 3600000) { trendJobs.delete(jobId); return c.json({ error: "Job expired" }, 404); }
  return c.json({ jobId, status: job.status, platform: job.platform, collected: job.collected, error: job.error, platformsProgress: job.platformsProgress ?? [] });
});

// ---------------------------------------------------------------------------
// Digital Human API
// ---------------------------------------------------------------------------

function avatarDir(id: string): string { return join(dataDir, "avatars", id); }
function jobOutputDir(id: string): string { return join(dataDir, "digital-human-jobs", id); }

// GET /api/digital-humans/config-status - check heygem credential status
apiRoutes.get("/api/digital-humans/config-status", async (c) => {
  const config = await loadConfig();
  return c.json({
    heygemConfigured: Boolean(
      config.heygem?.baseUrl && config.heygem?.apiToken && config.heygem?.tunnel?.host
    ),
  });
});

// GET /api/digital-humans/instance/status - current GPU instance view
apiRoutes.get("/api/digital-humans/instance/status", async (c) => {
  return c.json(await getInstanceView());
});

// GET /api/h3/instance/status - H3 本地视频生成实例（AutoDL ComfyUI）状态
apiRoutes.get("/api/h3/instance/status", async (c) => {
  return c.json(await getH3InstanceView());
});

// GET /api/autodl/reminders - 作品页 AutoDL 开机提醒聚合（2026-08-14）
// 在素材准备阶段开始前提醒开机：
//   数字人渲染(HeyGem 实例): 作品绑定了 digitalHumanId 且尚无 done 任务
//   H3 视频生成: 分镜已产出 → 扫描 storyboard.md 的素材路由精确判断(confirmed);
//               分镜未产出 → assetSource∈{ai,auto,smart} 预估(possible)
apiRoutes.get("/api/autodl/reminders", async (c) => {
  interface NeedItem { id: string; title: string; certainty?: "confirmed" | "possible" }
  const h3NeededBy: NeedItem[] = [];
  const h3Upcoming: NeedItem[] = [];
  const heygemNeededBy: NeedItem[] = [];
  const heygemUpcoming: NeedItem[] = [];
  try {
    const works = worksRepo.listWorks();
    // 时机门(2026-08-16):只有临近素材阶段的进行中作品才催开机。
    // 此前把排队中/分镜未产出的作品也列为 possible,用户看到横幅就提前开机,
    // 但串行 runner 下后面的作品几小时后才到素材阶段——GPU 空烧。
    const runningIds = new Set(
      workQueueRepo.listQueue().filter((i) => i.status === "running").map((i) => i.workId),
    );
    for (const w of works) {
      if (w.type !== "short-video") continue;
      if (w.status === "published" || w.status === "draft") continue;
      // 素材阶段已完成的作品无需提醒
      const steps = worksRepo.getWorkSteps(w.id);
      const assetsStep = steps.find((s) => s.step_key === "assets");
      if (assetsStep && assetsStep.status === "done") continue;
      const planStep = steps.find((s) => s.step_key === "plan");
      // 临近素材 = 素材阶段进行中，或分镜已完成且作品正在 runner 上执行
      const nearAssets = assetsStep?.status === "active"
        || (planStep?.status === "done" && runningIds.has(w.id));

      if (w.digital_human_id) {
        const done = dhJobsRepo.listJobs(w.id).some((j) => j.status === "done");
        if (!done) (nearAssets ? heygemNeededBy : heygemUpcoming).push({ id: w.id, title: w.title });
      }

      const sbPath = join(dataDir, "works", w.id, "plan", "storyboard.md");
      if (existsSync(sbPath)) {
        try {
          const sb = readFileSync(sbPath, "utf-8");
          if (/ai_video|i2v|local-h3|H3|AI\s*生(成)?视频/i.test(sb)) {
            // 分镜已确认需要 H3：临近素材阶段才催开机，否则列入 upcoming 预告
            (nearAssets ? h3NeededBy : h3Upcoming).push({ id: w.id, title: w.title, certainty: "confirmed" });
          }
        } catch { /* 读取失败按无需求处理 */ }
      } else if (nearAssets && w.asset_source && ["ai", "auto", "smart"].includes(w.asset_source)) {
        // 分镜未产出但临近素材：按素材来源预估(possible)
        h3NeededBy.push({ id: w.id, title: w.title, certainty: "possible" });
      }
    }
  } catch (err) {
    console.error("[autodl-reminders] scan failed:", err);
  }
  const [h3, heygem] = await Promise.all([getH3InstanceView(), getInstanceView()]);
  return c.json({
    h3: { state: h3.state, consoleUrl: h3.consoleUrl, neededBy: h3NeededBy, upcoming: h3Upcoming },
    heygem: { state: heygem.state, consoleUrl: heygem.consoleUrl, neededBy: heygemNeededBy, upcoming: heygemUpcoming },
  });
});

// POST /api/ssh/push-key — 设置页"一键免密":密码认证推送本机公钥到实例
apiRoutes.post("/api/ssh/push-key", async (c) => {
  const body = await c.req.json();
  const { host, port, user, password } = body;
  if (!host || !port || !password) {
    return c.json({ success: false, error: "Missing required fields: host, port, password" }, 400);
  }
  try {
    const message = await pushPublicKey({ host, port: Number(port), user: user || "root", password });
    return c.json({ success: true, message });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 400);
  }
});

apiRoutes.get("/api/digital-humans/avatars", async (c) => {
  return c.json({ avatars: avatarsRepo.listAvatars() });
});

// POST /api/digital-humans/avatars — upload avatar source video
apiRoutes.post("/api/digital-humans/avatars", async (c) => {
  try {
    const body = await c.req.parseBody();
    const name = (body.name as string) || "New Avatar";
    const file = body.file as File | undefined;
    if (!file) return c.json({ error: "file is required" }, 400);
    const buffer = Buffer.from(await file.arrayBuffer());
    const avatar = await createAvatarFromUpload(name, buffer, file.name);
    return c.json(avatar, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Avatar creation failed";
    // 非视频文件属于客户端输入错误，返回 400 而非 500
    if (message.includes("源视频")) return c.json({ error: message }, 400);
    return c.json({ error: message }, 500);
  }
});

// GET /api/digital-humans/avatars/:id
apiRoutes.get("/api/digital-humans/avatars/:id", async (c) => {
  const id = c.req.param("id");
  const avatar = avatarsRepo.getAvatar(id);
  if (!avatar) return c.json({ error: "Avatar not found" }, 404);
  return c.json(avatar);
});

// GET /api/digital-humans/avatars/:id/media/:filename
apiRoutes.get("/api/digital-humans/avatars/:id/media/:filename", async (c) => {
  const id = c.req.param("id");
  const filename = c.req.param("filename");
  try {
    const safe = basename(filename);
    const avatarRoot = resolve(avatarDir(id));
    const filePath = resolve(avatarRoot, safe);
    if (!filePath.startsWith(avatarRoot + sep) && filePath !== avatarRoot) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const data = await readFile(filePath);
    return new Response(data, { headers: { "Content-Type": getMimeType(filename) } });
  } catch {
    return c.json({ error: "Media not found" }, 404);
  }
});

// GET /api/digital-humans/avatars/:id/frame
apiRoutes.get("/api/digital-humans/avatars/:id/frame", async (c) => {
  const id = c.req.param("id");
  try {
    const data = await readFile(join(avatarDir(id), "frame.jpg"));
    return new Response(data, { headers: { "Content-Type": "image/jpeg" } });
  } catch {
    return c.json({ error: "Frame not found" }, 404);
  }
});

// DELETE /api/digital-humans/avatars/:id
apiRoutes.delete("/api/digital-humans/avatars/:id", async (c) => {
  const id = c.req.param("id");
  // 校验 ID 格式并确认记录存在后才删文件，杜绝 ../ 路径逃逸删除 dataDir 之外的目录
  if (!isValidAvatarId(id)) return c.json({ error: "Avatar not found" }, 404);
  const avatar = avatarsRepo.getAvatar(id);
  if (!avatar) return c.json({ error: "Avatar not found" }, 404);
  // 有进行中任务的形象不允许删除（spec §7.2）
  const active = dhJobsRepo.countActiveJobsByAvatar(id);
  if (active > 0) return c.json({ error: "该形象有进行中任务，无法删除" }, 409);
  try {
    await rm(avatarDir(id), { recursive: true, force: true });
  } catch { /* directory may not exist */ }
  const ok = avatarsRepo.deleteAvatar(id);
  return c.json({ deleted: ok });
});

// POST /api/digital-humans/avatars/:id/default
apiRoutes.post("/api/digital-humans/avatars/:id/default", async (c) => {
  const id = c.req.param("id");
  const avatar = await setDefaultAvatar(id);
  if (!avatar) return c.json({ error: "Avatar not found" }, 404);
  return c.json(avatar);
});

// POST /api/digital-humans/jobs
apiRoutes.post("/api/digital-humans/jobs", async (c) => {
  try {
    const body = await c.req.json();
    const { avatarId, audioUrl, workId, scriptId, estimatedCost } = body;
    if (!avatarId || !audioUrl) return c.json({ error: "avatarId and audioUrl required" }, 400);
    const job = await submitJob({ avatarId, audioUrl, workId, scriptId, estimatedCost });
    return c.json(job, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Job submission failed";
    // 实例未就绪属于状态冲突，返回 409 让前端引导开机
    if (message.includes("开机")) return c.json({ error: message }, 409);
    return c.json({ error: message }, 500);
  }
});

// GET /api/digital-humans/jobs
apiRoutes.get("/api/digital-humans/jobs", async (c) => {
  return c.json({ jobs: dhJobsRepo.listJobs() });
});

// GET /api/digital-humans/jobs/:id
apiRoutes.get("/api/digital-humans/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = dhJobsRepo.getJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// POST /api/digital-humans/jobs/:id/refresh
apiRoutes.post("/api/digital-humans/jobs/:id/refresh", async (c) => {
  const id = c.req.param("id");
  try {
    const job = await refreshJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Refresh failed" }, 500);
  }
});

// DELETE /api/digital-humans/jobs/:id
apiRoutes.delete("/api/digital-humans/jobs/:id", async (c) => {
  const ok = await deleteJob(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "Job not found" }, 404);
});

// POST /api/digital-humans/jobs/:id/regenerate - resubmit with same params
apiRoutes.post("/api/digital-humans/jobs/:id/regenerate", async (c) => {
  try {
    return c.json(await regenerateJob(c.req.param("id")), 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

// GET /api/digital-humans/jobs/:id/output
apiRoutes.get("/api/digital-humans/jobs/:id/output", async (c) => {
  const id = c.req.param("id");
  try {
    const data = await readFile(join(jobOutputDir(id), "output.mp4"));
    return new Response(data, { headers: { "Content-Type": "video/mp4" } });
  } catch {
    return c.json({ error: "Output not found" }, 404);
  }
});

// POST /api/works/:id/digital-human/run — 单作品口播 TTS + 数字人渲染（只提交不等待）
apiRoutes.post("/api/works/:id/digital-human/run", async (c) => {
  const id = c.req.param("id");
  try {
    const result = await runDigitalHumanForWork(id);
    return c.json(result, result.skipped ? 200 : 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Digital human run failed";
    // 实例未就绪属于状态冲突，返回 409 让前端引导开机
    if (message.includes("开机")) return c.json({ error: message }, 409);
    return c.json({ error: message }, 400);
  }
});

// GET /api/digital-humans/batch/pending — 待批量渲染的作品列表
apiRoutes.get("/api/digital-humans/batch/pending", async (c) => {
  const works = await listPendingWorks();
  return c.json({ count: works.length, works });
});

// POST /api/digital-humans/batch/run — 触发批量渲染（fire-and-forget，状态走 batch/status 轮询）
apiRoutes.post("/api/digital-humans/batch/run", async (c) => {
  runBatchDigitalHuman().catch((err) => {
    log("error", "api", "digital_human_batch_run_error", "-", { error: err instanceof Error ? err.message : String(err) });
  });
  return c.json(getBatchState(), 202);
});

// GET /api/digital-humans/batch/status — 批量渲染进度
apiRoutes.get("/api/digital-humans/batch/status", async (c) => {
  return c.json(getBatchState());
});

// POST /api/digital-humans/render-now — 手动立即渲染（触发条件 c）：集中提交渲染池内 queued 任务。
// 实例离线时不提交（任务保持 queued），响应中 pendingBoot=true 供前端引导开机。
apiRoutes.post("/api/digital-humans/render-now", async (c) => {
  triggerRenderNow().catch((err) => {
    log("error", "api", "digital_human_render_now_error", "-", { error: err instanceof Error ? err.message : String(err) });
  });
  return c.json({ ...getBatchState(), pendingBoot: getPendingBoot() }, 202);
});

// GET /api/digital-humans/render-pool — 渲染池现状：queued 任务（按队列顺序）+ pendingBoot + 实例在线状态
apiRoutes.get("/api/digital-humans/render-pool", async (c) => {
  const instance = await getInstanceView();
  return c.json({
    items: getRenderPool(),
    pendingBoot: getPendingBoot(),
    instance: { state: instance.state, consoleUrl: instance.consoleUrl },
    batch: getBatchState(),
  });
});

// ---------------------------------------------------------------------------
// Asset Library API
// ---------------------------------------------------------------------------

// GET /api/assets
apiRoutes.get("/api/assets", async (c) => {
  const category = c.req.query("category") as any;
  const type = c.req.query("type") as any;
  const source = c.req.query("source") as any;
  const tag = c.req.query("tag");
  const compliance = c.req.query("compliance") as any;
  const assets = listLibraryAssets({ category, type, source, tag, compliance });
  return c.json({ assets });
});

// POST /api/assets
apiRoutes.post("/api/assets", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file as File | undefined;
    if (!file) return c.json({ error: "file is required" }, 400);
    const category = (body.category as any) || "general";
    const source = (body.source as any) || "upload";
    const license = (body.license as any) || (source === "upload" ? "needs-review" : "unknown");
    const tagsRaw = (body.tags as string) || "";
    const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
    const metadata = body.metadata ? JSON.parse(body.metadata as string) : {};
    const buffer = Buffer.from(await file.arrayBuffer());
    const asset = await uploadLibraryAsset({
      name: file.name,
      data: buffer,
      category,
      source,
      license,
      tags,
      metadata,
    });
    return c.json(asset, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Asset upload failed" }, 500);
  }
});

// GET /api/assets/:id
apiRoutes.get("/api/assets/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const asset = assetsRepo.getAsset(id);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  return c.json({ ...asset, url: `/api/shared-assets/${encodeURIComponent(asset.category)}/${encodeURIComponent(asset.name)}` });
});

// PUT /api/assets/:id
apiRoutes.put("/api/assets/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  try {
    const body = await c.req.json();
    const allowed = ["name", "category", "type", "tags", "source", "license", "metadata"];
    const updates = Object.fromEntries(allowed.filter((k) => k in body).map((k) => [k, body[k]]));
    const asset = await updateLibraryAsset(id, updates);
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return c.json(asset);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Update failed" }, 500);
  }
});

// DELETE /api/assets/:id
apiRoutes.delete("/api/assets/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const ok = await deleteLibraryAsset(id);
  return c.json({ deleted: ok });
});

// POST /api/assets/:id/compliance
apiRoutes.post("/api/assets/:id/compliance", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const asset = await recheckCompliance(id);
  if (!asset) return c.json({ error: "Asset not found" }, 404);
  return c.json(asset);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = join(dataDir, "shared-assets", "templates");

function templateToApi(t: DbTemplate) {
  // poster.png 存在时一并返回，前端模板卡片直接显示图片
  // （preview_url 可能是 /preview-file 视频端点，<img> 无法渲染）
  const posterPath = join(TEMPLATE_DIR, t.id, "poster.png");
  const posterUrl = existsSync(posterPath) ? `/api/shared-assets/templates/${t.id}/poster.png` : undefined;
  return {
    id: t.id,
    name: t.name,
    contentForm: t.content_form,
    canvas: t.canvas,
    variables: t.variables,
    layers: t.layers,
    audio: t.audio,
    subtitles: t.subtitles,
    transitions: t.transitions,
    branding: t.branding,
    previewUrl: t.preview_url,
    posterUrl,
    status: t.status,
    kind: t.kind ?? "video",
    usageCount: t.usage_count ?? 0,
    // 模板质量评分(0-100,template-score):批量弹窗据此排序/打精品标
    score: scoreTemplate(t).score,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// POST /api/templates/generate - start async AI template generation (DB-backed, survives page switches)
// kind=image-text 走图文版式生成器，默认 video 走视频时间线生成器
apiRoutes.post("/api/templates/generate", async (c) => {
  const body = await c.req.json<{ reference?: string; count?: number; contentForm?: string; elements?: TemplateElements; kind?: string }>().catch(() => ({ reference: undefined, count: undefined, contentForm: undefined, elements: undefined, kind: undefined }));
  const jobId = "tplgen_" + Date.now();
  const count = body.count ?? 5;
  const isImageText = body.kind === "image-text";

  // Persist job to DB so it survives page switches / component unmounts
  try {
    const db = getDb();
    db.prepare("INSERT INTO template_gen_jobs (id, status, count, generated, kind) VALUES (?, 'running', ?, 0, 'generate')").run(jobId, count);
  } catch {
    // If table doesn't exist yet (migration not run), fall back to in-memory
  }

  // Run generation asynchronously (fire and forget)
  const generation: Promise<DbTemplate[]> = isImageText
    ? generateImageTextTemplates({ count: body.count })
    : generateTemplates({
        reference: body.reference,
        count: body.count,
        contentForm: body.contentForm as "hot_comment" | "knowledge" | "industry" | "insight" | undefined,
        elements: body.elements,
      });
  generation
    .then((templates) => {
      try {
        const db = getDb();
        db.prepare("UPDATE template_gen_jobs SET status = 'done', generated = ?, updated_at = datetime('now') WHERE id = ?").run(templates.length, jobId);
      } catch {}
    })
    .catch((err) => {
      try {
        const db = getDb();
        db.prepare("UPDATE template_gen_jobs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?").run(err instanceof Error ? err.message : String(err), jobId);
      } catch {}
    });

  return c.json({ jobId, status: "running", message: "模板生成已启动，可切换页面，稍后回来查看结果" });
});

// GET /api/templates/generate/status/:jobId - poll async template generation status (DB-backed)
apiRoutes.get("/api/templates/generate/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM template_gen_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: "Job not found" }, 404);
    return c.json({ jobId, status: row.status, generated: row.generated, error: row.error });
  } catch {
    return c.json({ error: "Job tracking not available" }, 500);
  }
});

// GET /api/templates/generate/active - check if there's any running job (for page re-entry)
apiRoutes.get("/api/templates/generate/active", async (c) => {
  try {
    const db = getDb();
    // Clean up jobs older than 20 minutes that are still "running" (likely crashed).
    // Template generation runs in batches of 3 (each ~4 min), so 10 templates can
    // legitimately take ~16 minutes.
    db.prepare("UPDATE template_gen_jobs SET status = 'error', error = 'Job timed out (no status update in 20 min)' WHERE status = 'running' AND created_at < datetime('now', '-20 minutes')").run();
    const row = db.prepare("SELECT * FROM template_gen_jobs WHERE status = 'running' AND kind = 'generate' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return c.json({ active: false });
    return c.json({ active: true, jobId: row.id, count: row.count });
  } catch {
    return c.json({ active: false });
  }
});

// ---------------------------------------------------------------------------
// 模板二次加工(2026-08-13 模板库改造 功能 b)
// ---------------------------------------------------------------------------

interface RefineJob {
  status: "running" | "done" | "error";
  templateId?: string;
  diffSummary?: string;
  copied?: boolean;
  error?: string;
}
const refineJobs = new Map<string, RefineJob>();

// POST /api/templates/:id/refine - 自然语言二次加工模板(异步)
apiRoutes.post("/api/templates/:id/refine", async (c) => {
  const id = c.req.param("id");
  if (!getTemplate(id)) return c.json({ error: "Template not found" }, 404);
  const body = await c.req.json<{ instruction?: string; saveAsCopy?: boolean }>().catch(() => ({} as { instruction?: string; saveAsCopy?: boolean }));
  if (!body.instruction?.trim()) return c.json({ error: "instruction is required" }, 400);

  const jobId = "tplrefine_" + Date.now();
  refineJobs.set(jobId, { status: "running" });
  refineTemplate(id, body.instruction, body.saveAsCopy ?? false)
    .then((r) => refineJobs.set(jobId, { status: "done", templateId: r.templateId, diffSummary: r.diffSummary, copied: r.copied }))
    .catch((err) => refineJobs.set(jobId, { status: "error", error: err instanceof Error ? err.message : String(err) }));
  return c.json({ jobId, status: "running" });
});

// GET /api/templates/refine/status/:jobId
apiRoutes.get("/api/templates/refine/status/:jobId", async (c) => {
  const job = refineJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// ---------------------------------------------------------------------------
// 优秀作品模板克隆(2026-08-13 模板库改造 功能 a,二期)
// ---------------------------------------------------------------------------

interface CloneJob {
  status: "running" | "done" | "error";
  stage?: string;
  templateId?: string;
  name?: string;
  kind?: string;
  error?: string;
}
const cloneJobs = new Map<string, CloneJob>();

// POST /api/templates/clone - 粘贴优秀作品链接克隆模板(异步)
function startCloneJob(opts: { url: string; name?: string; hint?: string; cleanupSource?: boolean }): string {
  const jobId = "tplclone_" + Date.now();
  cloneJobs.set(jobId, { status: "running", stage: "download" });
  cloneTemplate({
    ...opts,
    onStage: (stage) => {
      const job = cloneJobs.get(jobId);
      if (job) cloneJobs.set(jobId, { ...job, stage });
    },
  })
    .then((r) => cloneJobs.set(jobId, { status: "done", templateId: r.templateId, name: r.name, kind: r.kind }))
    .catch((err) => cloneJobs.set(jobId, { status: "error", error: err instanceof Error ? err.message : String(err) }));
  return jobId;
}

apiRoutes.post("/api/templates/clone", async (c) => {
  const body = await c.req.json<{ url?: string; name?: string; hint?: string }>().catch(() => ({} as { url?: string; name?: string; hint?: string }));
  if (!body.url?.trim()) return c.json({ error: "url is required" }, 400);
  try {
    routeCloneUrl(body.url);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "不支持的链接" }, 400);
  }
  const jobId = startCloneJob({ url: body.url, name: body.name, hint: body.hint });
  return c.json({ jobId, status: "running" });
});

// POST /api/templates/clone/upload - 上传本地视频文件克隆(2026-08-13:视频号等
// 无视频流平台的通路——用户用 res-downloader 嗅探/录屏拿到 mp4 后直接上传)
apiRoutes.post("/api/templates/clone/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "缺少 file 字段(multipart)" }, 400);
  const ext = (file.name.match(/\.(mp4|mov|webm|mkv|avi)$/i)?.[0] ?? ".mp4").toLowerCase();
  const uploadDir = join(dataDir, "uploads");
  await mkdir(uploadDir, { recursive: true });
  const savedPath = join(uploadDir, `clone-upload-${Date.now()}${ext}`);
  await writeFile(savedPath, Buffer.from(await file.arrayBuffer()));
  const hint = typeof body["hint"] === "string" ? body["hint"] : undefined;
  const jobId = startCloneJob({ url: savedPath, hint, cleanupSource: true });
  return c.json({ jobId, status: "running" });
});

// GET /api/templates/clone/status/:jobId
apiRoutes.get("/api/templates/clone/status/:jobId", async (c) => {
  const job = cloneJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// ---------------------------------------------------------------------------
// 模板调研学习 + 技能库（2026-08-03 模板自进化）
// ---------------------------------------------------------------------------

// POST /api/templates/research - 按要素组合调研全网优秀模板，蒸馏技能入库（异步）
apiRoutes.post("/api/templates/research", async (c) => {
  const body = await c.req.json<{ elements?: TemplateElements }>().catch(() => ({} as { elements?: TemplateElements }));
  const jobId = "tplresearch_" + Date.now();
  try {
    const db = getDb();
    db.prepare("INSERT INTO template_gen_jobs (id, status, count, generated, kind) VALUES (?, 'running', 0, 0, 'research')").run(jobId);
  } catch {}

  researchTemplates(body.elements ?? {})
    .then((result) => {
      try {
        const db = getDb();
        db.prepare("UPDATE template_gen_jobs SET status = 'done', generated = ?, updated_at = datetime('now') WHERE id = ?").run(result.added, jobId);
      } catch {}
    })
    .catch((err) => {
      try {
        const db = getDb();
        db.prepare("UPDATE template_gen_jobs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?").run(err instanceof Error ? err.message : String(err), jobId);
      } catch {}
    });

  return c.json({ jobId, status: "running", message: "模板调研学习已启动（约 2-5 分钟），可切换页面" });
});

// GET /api/templates/research/status/:jobId
apiRoutes.get("/api/templates/research/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM template_gen_jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
    if (!row) return c.json({ error: "Job not found" }, 404);
    return c.json({ jobId, status: row.status, added: row.generated, error: row.error });
  } catch {
    return c.json({ error: "Job tracking not available" }, 500);
  }
});

// GET /api/templates/research/active
apiRoutes.get("/api/templates/research/active", async (c) => {
  try {
    const db = getDb();
    const row = db.prepare("SELECT * FROM template_gen_jobs WHERE status = 'running' AND kind = 'research' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return c.json({ active: false });
    return c.json({ active: true, jobId: row.id });
  } catch {
    return c.json({ active: false });
  }
});

// GET /api/templates/skills - 技能库列表（生成时自动注入的经验）
apiRoutes.get("/api/templates/skills", async (c) => {
  const skills = listSkills(undefined, 100);
  return c.json({ skills });
});

// DELETE /api/templates/skills/:id - 删除一条技能
apiRoutes.delete("/api/templates/skills/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Invalid skill id" }, 400);
  return deleteSkill(id) ? c.json({ deleted: true }) : c.json({ error: "Skill not found" }, 404);
});

// GET /api/templates/:id/preview-file — stream the rendered 5s preview mp4
// （renderTemplatePreview 将 preview_url 设置为此端点，必须存在否则 404）
apiRoutes.get("/api/templates/:id/preview-file", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return c.json({ error: "Invalid template id" }, 400);
  const previewPath = join(dataDir, "templates", `${id}-preview.mp4`);
  if (!existsSync(previewPath)) return c.json({ error: "Preview not rendered yet" }, 404);
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const s = await stat(previewPath);
  return new Response(createReadStream(previewPath) as unknown as ReadableStream, {
    headers: { "Content-Type": "video/mp4", "Content-Length": String(s.size), "Cache-Control": "no-cache" },
  });
});

apiRoutes.get("/api/templates", async (c) => {
  const status = c.req.query("status") as DbTemplate["status"] | undefined;
  const contentForm = c.req.query("contentForm") || undefined;
  const kind = c.req.query("kind") as DbTemplate["kind"] | undefined;
  const templates = listTemplates(status, contentForm, kind);
  return c.json({ templates: templates.map(templateToApi) });
});

apiRoutes.get("/api/templates/:id", async (c) => {
  const id = c.req.param("id");
  const template = getTemplate(id);
  if (!template) return c.json({ error: "Template not found" }, 404);
  return c.json(templateToApi(template));
});

apiRoutes.post("/api/templates", async (c) => {
  try {
    const body = await c.req.json();
    // 图文模板不走视频时间线校验(layers 是 LayoutSpec 而非时间线层)
    if (body.kind === "image-text") {
      const template = createTemplate({
        id: body.id ?? `tpl_it_${randomUUID().slice(0, 8)}`,
        name: body.name ?? "未命名图文模板",
        content_form: body.contentForm ?? "image-text",
        canvas: body.canvas ?? { width: 1080, height: 1440, fps: 30 },
        variables: body.variables ?? [],
        layers: body.layers ?? [],
        audio: [],
        transitions: [],
        branding: sanitizeBranding(body.branding),
        status: (body.status as DbTemplate["status"]) ?? "draft",
        kind: "image-text",
      });
      return c.json(templateToApi(template), 201);
    }
    const validated = validateTemplate({ id: body.id ?? `tpl_${randomUUID().slice(0, 8)}`, ...body });
    const template = createTemplate({
      id: validated.id,
      name: validated.name,
      content_form: validated.contentForm,
      canvas: validated.canvas,
      variables: validated.variables,
      layers: validated.timeline.layers as unknown as Record<string, unknown>[],
      audio: validated.timeline.audio as unknown as Record<string, unknown>[],
      subtitles: validated.timeline.subtitles as unknown as Record<string, unknown> | undefined,
      transitions: (validated.timeline.transitions ?? []) as unknown as Record<string, unknown>[],
      status: (body.status as DbTemplate["status"]) ?? "draft",
    });
    return c.json(templateToApi(template), 201);
  } catch (err) {
    const message = err instanceof TimelineValidationError ? err.message : err instanceof Error ? err.message : "Invalid template";
    return c.json({ error: message }, 400);
  }
});

apiRoutes.put("/api/templates/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getTemplate(id);
  if (!existing) return c.json({ error: "Template not found" }, 404);
  try {
    const body = await c.req.json();
    // Normalize canvas: ensure width, height, fps are numbers
    if (body.canvas) {
      if (typeof body.canvas.width !== "number") body.canvas.width = 1080;
      if (typeof body.canvas.height !== "number") body.canvas.height = 1920;
      if (typeof body.canvas.fps !== "number") body.canvas.fps = 30;
      if (!body.canvas.backgroundColor) body.canvas.backgroundColor = "#0a0a0a";
    }
    // Normalize layers: ensure id, start, duration, position, size exist
    if (Array.isArray(body.layers)) {
      body.layers = body.layers.map((layer: any, i: number) => {
        const l = { ...layer };
        if (!l.id || typeof l.id !== "string") l.id = `layer_${i}`;
        if (typeof l.start !== "number") l.start = 0;
        if (typeof l.duration !== "number") l.duration = 10;
        if (!l.position) l.position = { x: 0, y: 0 };
        else if (typeof l.position === "string") {
          // 保留合法方位词(center/top/bottom/left/right),只归零非法字符串
          if (!["center", "top", "bottom", "left", "right"].includes(l.position)) l.position = { x: 0, y: 0 };
        } else {
          if (typeof l.position.x !== "number") l.position.x = 0;
          if (typeof l.position.y !== "number") l.position.y = 0;
        }
        if (l.type === "text") {
          if (!l.content && l.text) l.content = l.text;
          if (!l.content) l.content = "";
          const style = l.style;
          if (style) {
            if (style.fontSize && !l.fontSize) l.fontSize = style.fontSize;
            if (style.color && !l.color) l.color = style.color;
            if (style.align && !l.align) l.align = style.align;
            delete l.style;
          }
          if (typeof l.fontSize !== "number") l.fontSize = 40;
          if (!l.color) l.color = "#FFFFFF";
          if (!l.align) l.align = "left";
        }
        if (l.type === "shape") {
          if (!l.shape) l.shape = "rect";
          if (!l.fill && l.color) l.fill = l.color;
          if (!l.fill) l.fill = "#FFFFFF";
          if (!l.size || typeof l.size !== "object") l.size = { width: 100, height: 100 };
          else {
            if (typeof l.size.width !== "number") l.size.width = 100;
            if (typeof l.size.height !== "number") l.size.height = 100;
          }
          delete l.color;
        }
        if ((l.type === "image" || l.type === "video") && (!l.size || typeof l.size !== "object")) {
          l.size = { width: 100, height: 100 };
        }
        return l;
      });
    }
    // branding:显式传 null 清除;传对象则规范化;未传保留原值
    const branding = body.branding === null ? undefined
      : body.branding !== undefined ? sanitizeBranding(body.branding)
      : existing.branding;
    if (branding && !existsSync(join(dataDir, "shared-assets", branding.logoAsset))) {
      return c.json({ error: `logo 文件不存在: ${branding.logoAsset}(请先上传到共享素材 branding 类)` }, 400);
    }
    // 图文模板不走视频时间线校验(layers 是 LayoutSpec;此前 PUT 必 400)
    if (existing.kind === "image-text") {
      const updated = updateTemplate(id, {
        name: body.name ?? existing.name,
        content_form: body.contentForm ?? existing.content_form,
        canvas: body.canvas ?? existing.canvas,
        layers: body.layers ?? existing.layers,
        branding,
        status: (body.status as DbTemplate["status"]) ?? existing.status,
      });
      if (!updated) return c.json({ error: "Template update failed" }, 500);
      return c.json(templateToApi(updated));
    }
    const validated = validateTemplate({ ...existing, ...body, id });
    const updated = updateTemplate(id, {
      name: validated.name,
      content_form: validated.contentForm,
      canvas: validated.canvas,
      variables: validated.variables,
      layers: validated.timeline.layers as unknown as Record<string, unknown>[],
      audio: validated.timeline.audio as unknown as Record<string, unknown>[],
      subtitles: validated.timeline.subtitles as unknown as Record<string, unknown> | undefined,
      transitions: (validated.timeline.transitions ?? []) as unknown as Record<string, unknown>[],
      branding,
      status: (body.status as DbTemplate["status"]) ?? existing.status,
    });
    if (!updated) return c.json({ error: "Template update failed" }, 500);
    return c.json(templateToApi(updated));
  } catch (err) {
    const message = err instanceof TimelineValidationError ? err.message : err instanceof Error ? err.message : "Invalid template";
    return c.json({ error: message }, 400);
  }
});

apiRoutes.delete("/api/templates/:id", async (c) => {
  const id = c.req.param("id");
  const ok = deleteTemplate(id);
  if (!ok) return c.json({ error: "Template not found" }, 404);
  return c.json({ deleted: true });
});

// GET /api/templates/:id/score - 模板质量评分(2026-08-14 模板精品化)
apiRoutes.get("/api/templates/:id/score", async (c) => {
  const template = getTemplate(c.req.param("id"));
  if (!template) return c.json({ error: "Template not found" }, 404);
  const { scoreTemplate } = await import("../services/template-score.js");
  return c.json(scoreTemplate(template as any));
});

// GET /api/templates/:id/poster - generate a rich poster from template layers
/** 模板带品牌 logo 时叠加到 poster 图(兜底 poster 路径不经 renderTimeline,需单独叠加) */
async function overlayBrandingOnPoster(template: DbTemplate, posterPath: string): Promise<void> {
  if (!template.branding?.logoAsset) return;
  const { brandingAssetPath, brandingPixelPosition } = await import("../video/branding.js");
  const logoPath = brandingAssetPath(template.branding.logoAsset);
  if (!existsSync(logoPath)) return;
  const pos = brandingPixelPosition(template.branding, template.canvas);
  const w = template.branding.width ?? 160;
  const o = template.branding.opacity ?? 1;
  const tmpPoster = posterPath + ".tmp.png";
  try {
    await execFileAsync("ffmpeg", [
      "-i", posterPath, "-i", logoPath,
      "-filter_complex", `[1:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${o}[logo];[0:v][logo]overlay=${pos.x}:${pos.y}`,
      "-frames:v", "1", "-y", tmpPoster,
    ], { timeout: 10000 });
    await unlink(posterPath);
    await rename(tmpPoster, posterPath);
  } catch (err) {
    try { await unlink(tmpPoster); } catch {}
    console.error("[poster] logo overlay failed:", err);
  }
}

/** 模板目录下已生成的分幕单帧(scene-N.png)URL 列表,前端灯箱逐张查看 */
function storyboardFrameUrls(id: string): string[] {
  try {
    return readdirSync(join(TEMPLATE_DIR, id))
      .filter((f) => /^scene-\d+\.png$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)![0]) - parseInt(b.match(/\d+/)![0]))
      .map((f) => `/api/shared-assets/templates/${id}/${f}`);
  } catch {
    return [];
  }
}

apiRoutes.get("/api/templates/:id/poster", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return c.json({ error: "Invalid template id" }, 400);
  const template = getTemplate(id);
  if (!template) return c.json({ error: "Template not found" }, 404);

  const posterDir = join(TEMPLATE_DIR, id);
  await mkdir(posterDir, { recursive: true });
  const posterPath = join(posterDir, "poster.png");
  const videoPosterPath = join(posterDir, "poster.mp4");

  // If video poster already exists, serve it as the poster
  if (existsSync(videoPosterPath)) {
    // Extract a mid-clip frame as PNG (first frame may predate layer entrance animations)
    try {
      await execFileAsync("ffmpeg", ["-ss", "2.5", "-i", videoPosterPath, "-frames:v", "1", "-y", posterPath], { timeout: 10000 });
      return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png`, frameUrls: storyboardFrameUrls(id) });
    } catch {}
  }
  // If poster exists AND is newer than template's last update, serve cached version
  if (existsSync(posterPath)) {
    try {
      const posterStat = await stat(posterPath);
      const tplUpdatedAt = template.updated_at ? new Date(template.updated_at).getTime() : 0;
      // 缓存有效且分幕单帧齐全才直接返回(旧缓存只有 poster 没有 scene-*.png,需重生成)
      if (posterStat.mtimeMs > tplUpdatedAt && storyboardFrameUrls(id).length > 0) {
        return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png`, frameUrls: storyboardFrameUrls(id) });
      }
    } catch {}
    // Poster is stale, delete and regenerate
    try { await unlink(posterPath); } catch {}
  }

  // 图文模板(2026-08-13):用 LayoutSpec + 示例文案跑卡片渲染出封面 poster
  // (此前图文模板无预览图基建,preview_url 一直留空;顺带呈现 logo 效果)
  if (template.kind === "image-text") {
    try {
      const { layoutSpecsFromTemplate, buildCardHtml } = await import("../services/dual-output.js");
      const specs = layoutSpecsFromTemplate(template);
      if (!specs) return c.json({ error: "图文模板缺少 cover/content 版式" }, 400);
      const canvas = { width: template.canvas.width ?? 1080, height: template.canvas.height ?? 1440 };
      const html = buildCardHtml({
        spec: specs.cover,
        canvas,
        kind: "cover",
        title: template.name || "示例标题",
        subtitle: "封面预览示例文案",
        branding: template.branding,
      });
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: canvas.width, height: canvas.height } });
        await page.setContent(html, { waitUntil: "load" });
        await page.screenshot({ path: posterPath });
      } finally {
        await browser.close();
      }
      return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png` });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "图文 poster 渲染失败" }, 500);
    }
  }

  // 视频模板:分幕故事板 poster(2026-08-13 克隆模板"无法预览全部"修复)。
  // 旧方案只渲染前 5 秒抽一帧——多幕长模板(克隆产出可达数分钟)只能看到
  // 第一幕;故事板沿总时长均匀采 6 个时刻、每刻只画可见图层再拼 3×2 网格。
  try {
    const { renderStoryboardPoster } = await import("../services/template-storyboard.js");
    await renderStoryboardPoster(template, posterDir);
    await overlayBrandingOnPoster(template, posterPath);
    return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png`, frameUrls: storyboardFrameUrls(id) });
  } catch (sbErr) {
    console.error("[poster] storyboard failed, falling back to 5s render:", sbErr instanceof Error ? sbErr.message : sbErr);
  }

  // Try rendering a proper preview using the template's layers
  try {
    const { renderTemplatePreview } = await import("../services/template-generator.js");
    const result = await renderTemplatePreview(id);
    // renderTemplatePreview generates a 5-second video; extract a mid-clip frame
    // as poster (t=0 may predate staggered entrance animations and look empty)
    const previewVideoPath = join(dataDir, "templates", `${id}-preview.mp4`);
    if (existsSync(previewVideoPath)) {
      await execFileAsync("ffmpeg", ["-ss", "2.5", "-i", previewVideoPath, "-frames:v", "1", "-y", posterPath], { timeout: 10000 });
      return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png` });
    }
    // If video path is returned but doesn't exist at expected location, try it directly
    return c.json({ posterUrl: result.previewUrl });
  } catch (renderErr) {
    console.error("[poster] renderTemplatePreview failed:", renderErr instanceof Error ? renderErr.message : renderErr);
  }

  // Fallback: generate a multi-element poster using ffmpeg drawtext + drawbox
  const width = template.canvas?.width ?? 1080;
  const height = template.canvas?.height ?? 1920;
  const bgColorRaw = template.canvas?.backgroundColor ?? "#0a0a0a";
  const bgColor = normalizeColorForFfmpeg(bgColorRaw);
  const fontPaths = await resolveFontPaths();
  const fontPath = escapeFilterPath(fontPaths.bold);

  // Build a filter chain that draws all text and shape layers
  const filterParts: string[] = [];
  // Background is already the color input
  let filterIdx = 0;

  if (Array.isArray(template.layers)) {
    for (const layer of template.layers) {
      const l = layer as Record<string, unknown>;
      const lType = l.type as string;
      const lStart = (l.start as number) ?? 0;
      const lPos = l.position as { x?: number; y?: number } | string | undefined;
      const lSize = l.size as { width?: number; height?: number } | undefined;

      if (lType === "shape") {
        const shape = (l.shape as string) ?? "rect";
        const fill = (l.fill as string) ?? (l.color as string) ?? "#FFFFFF";
        const fillHex = normalizeColorForFfmpeg(fill, bgColorRaw);
        const sw = lSize?.width ?? 100;
        const sh = lSize?.height ?? 100;
        let px = 0, py = 0;
        if (lPos && typeof lPos === "object") { px = lPos.x ?? 0; py = lPos.y ?? 0; }
        filterParts.push(`drawbox=x=${px}:y=${py}:w=${sw}:h=${sh}:color=${fillHex}:t=fill`);
      } else if (lType === "text") {
        let text = (l.content as string) ?? (l.text as string) ?? template.name ?? "";
        // Resolve variable placeholders
        if (template.variables) {
          for (const v of template.variables) {
            if (v.default !== undefined) {
              text = text.replace(new RegExp(`{{${v.name}}}`, "g"), String(v.default));
            }
          }
        }
        text = text.replace(/{{[^}]+}}/g, "");
        const fontSize = (l.fontSize as number) ?? ((l.style as any)?.fontSize as number) ?? 40;
        const color = (l.color as string) ?? ((l.style as any)?.color as string) ?? "#FFFFFF";
        const colorHex = normalizeColorForFfmpeg(color);
        let px = 80, py = 200;
        if (lPos && typeof lPos === "object") { px = lPos.x ?? 80; py = lPos.y ?? 200; }
        // drawtext 不支持自动换行，按可用宽度拆成多行分别绘制
        const lines = wrapTextLines(text, fontSize, lSize?.width);
        const lineH = lineHeightFor(fontSize);
        lines.forEach((line, i) => {
          const safeLine = escapeDrawtext(line);
          filterParts.push(`drawtext=fontfile='${fontPath}':text='${safeLine}':fontsize=${fontSize}:fontcolor=${colorHex}:x=${px}:y=${py + i * lineH}:borderw=1:bordercolor=0x000000@0.5`);
        });
      }
    }
  }

  const filterStr = filterParts.length > 0 ? filterParts.join(",") : "null";

  try {
    await execFileAsync("ffmpeg", [
      "-f", "lavfi", "-i", "color=c=" + bgColor + ":s=" + width + "x" + height + ":d=1",
      "-vf", filterStr,
      "-frames:v", "1",
      "-y", posterPath,
    ], { timeout: 15000 });
    await overlayBrandingOnPoster(template, posterPath);
    return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png` });
  } catch (err) {
    // Last resort: solid color
    try {
      await execFileAsync("ffmpeg", [
        "-f", "lavfi", "-i", "color=c=" + bgColor + ":s=" + width + "x" + height,
        "-frames:v", "1", "-y", posterPath,
      ], { timeout: 10000 });
      await overlayBrandingOnPoster(template, posterPath);
      return c.json({ posterUrl: `/api/shared-assets/templates/${id}/poster.png` });
    } catch {
      return c.json({ error: "Failed to generate poster" }, 500);
    }
  }
});

// POST /api/templates/:id/preview — render a 5-second preview
apiRoutes.post("/api/templates/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return c.json({ error: "Invalid template id" }, 400);
  const template = getTemplate(id);
  if (!template) return c.json({ error: "Template not found" }, 404);
  const body = await c.req.json<{ variables?: Record<string, string | number> }>().catch(() => ({} as { variables?: Record<string, string | number> }));

  const previewDir = join(TEMPLATE_DIR, id);
  await mkdir(previewDir, { recursive: true });
  const outputPath = join(previewDir, "preview.mp4");
  const tmpPath = join(previewDir, `preview-${randomUUID()}.tmp.mp4`);

  try {
    const variableValues = { ...fillDefaults(template.variables), ...(body.variables ?? {}) };
    const defaultHostVideo = join(previewDir, "host.mp4");
    const defaultVoiceAudio = join(previewDir, "voice.wav");
    const hostVideo = variableValues.host_video ?? defaultHostVideo;
    const voiceAudio = variableValues.voice_audio ?? defaultVoiceAudio;

    const hasHostVideo = typeof hostVideo === "string" && existsSync(hostVideo);
    const hasVoiceAudio = typeof voiceAudio === "string" && existsSync(voiceAudio);

    if (hasHostVideo && hasVoiceAudio) {
      // Full preview with actual assets
      variableValues.host_video = hostVideo;
      variableValues.voice_audio = voiceAudio;
      const baseTimeline: Record<string, unknown> = {
        canvas: template.canvas,
        layers: template.layers,
        audio: template.audio,
        transitions: template.transitions,
      };
      if (template.subtitles && typeof template.subtitles === "object" && "source" in template.subtitles) {
        baseTimeline.subtitles = template.subtitles;
      }
      const timeline = applyVariables(baseTimeline, variableValues) as unknown as Timeline;
      await renderTimeline(timeline, { outputPath: tmpPath, preview: true, previewDuration: 5 });
      await rename(tmpPath, outputPath);
      updateTemplate(id, { preview_url: `/api/shared-assets/templates/${id}/preview.mp4` });
      return c.json({ previewUrl: `/api/shared-assets/templates/${id}/preview.mp4` });
    } else {
      // Source-free fallback: generate a poster image instead of video
      const posterPath = join(previewDir, "poster.png");
      const bgColorRaw = (template.canvas as any)?.backgroundColor ?? "0x1a1a2e";
      const bgColor = bgColorRaw.startsWith("#") ? "0x" + bgColorRaw.slice(1) : bgColorRaw;
      const tWidth = (template.canvas as any)?.width ?? 1080;
      const tHeight = (template.canvas as any)?.height ?? 1920;
      let overlayText = template.name ?? "Template Preview";
      if (Array.isArray(template.layers)) {
        for (const layer of template.layers) {
          if ((layer as any)?.type === "text" && (layer as any)?.text) {
            overlayText = String((layer as any).text).slice(0, 40);
            break;
          }
        }
      }
      const fontPath = process.platform === "win32"
        ? "C\:/Windows/Fonts/msyh.ttc"
        : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
      const safeText = overlayText.replace(/'/g, "\'");
      try {
        await execFileAsync("ffmpeg", [
          "-f", "lavfi", "-i", "color=c=" + bgColor + ":s=" + tWidth + "x" + tHeight,
          "-vf", "drawtext=fontfile='" + fontPath + "':text='" + safeText + "':fontsize=56:fontcolor=white:borderw=2:bordercolor=black@0.5:x=(w-text_w)/2:y=(h-text_h)/2",
          "-frames:v", "1", "-y", posterPath,
        ], { timeout: 10000 });
      } catch {
        // Last resort: solid color image
        await execFileAsync("ffmpeg", [
          "-f", "lavfi", "-i", "color=c=" + bgColor + ":s=" + tWidth + "x" + tHeight,
          "-frames:v", "1", "-y", posterPath,
        ], { timeout: 10000 });
      }
      updateTemplate(id, { preview_url: `/api/shared-assets/templates/${id}/poster.png` });
      // 模板带品牌 logo 时叠加到兜底 poster(此路径不经 renderTimeline,需单独处理)
      await overlayBrandingOnPoster(template, posterPath);
      return c.json({ previewUrl: `/api/shared-assets/templates/${id}/poster.png` });
    }
  } catch (err) {
    try { await unlink(tmpPath); } catch {}
    return c.json({ error: err instanceof Error ? err.message : "Preview failed" }, 500);
  }
});

// Render jobs
apiRoutes.get("/api/render-jobs", async (c) => {
  const status = c.req.query("status") as DbRenderJob["status"] | undefined;
  const workId = c.req.query("workId") || undefined;
  const jobs = listRenderJobs(status, workId);
  return c.json({ jobs });
});

apiRoutes.get("/api/render-jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = getRenderJob(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// Trigger render for a work
apiRoutes.post("/api/works/:id/render", async (c) => {
  const workId = c.req.param("id");
  const work = await getWork(workId);
  if (!work) return c.json({ error: "Work not found" }, 404);
  const body = await c.req.json<{
    templateId: string;
    digitalHumanVideo: string;
    voiceAudio: string;
    subtitlePath?: string;
    bgmPath?: string;
    assets?: Record<string, string>;
    variables?: Record<string, string | number>;
  }>().catch(() => ({} as any));

  if (!body.templateId) {
    return c.json({ error: "templateId is required" }, 400);
  }
  // 变量通用化:digitalHumanVideo/voiceAudio 仅当模板声明了对应变量时必填
  const renderTemplate = getTemplate(body.templateId);
  if (!renderTemplate) return c.json({ error: "Template not found" }, 404);
  const declaredVars = new Set((renderTemplate.variables ?? []).map((v) => v.name));
  if (declaredVars.has("host_video") && !body.digitalHumanVideo) {
    return c.json({ error: "digitalHumanVideo is required (template declares host_video)" }, 400);
  }
  if (declaredVars.has("voice_audio") && !body.voiceAudio) {
    return c.json({ error: "voiceAudio is required (template declares voice_audio)" }, 400);
  }

  try {
    const job = await startRender({
      workId,
      templateId: body.templateId,
      digitalHumanVideo: body.digitalHumanVideo,
      voiceAudio: body.voiceAudio,
      subtitlePath: body.subtitlePath,
      bgmPath: body.bgmPath,
      assets: body.assets ?? {},
      variables: body.variables ?? {},
    });
    return c.json(job, 202);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Render failed" }, 500);
  }
});

// ── Admin: backup, restore, migration ─────────────────────────────────────

apiRoutes.post("/api/admin/backup", async (c) => {
  const body = await c.req.json<{ path?: string }>().catch(() => ({ path: undefined } as { path?: string }));
  const dest = body.path ?? join(getConfigDir(), `autoviral-backup-${Date.now()}.zip`);
  await exportBackup(dest);
  return c.json({ ok: true, path: dest });
});

apiRoutes.post("/api/admin/restore", async (c) => {
  const body = await c.req.json<{ path?: string; overwrite?: boolean }>().catch(() => ({ path: undefined, overwrite: false } as { path?: string; overwrite?: boolean }));
  const src = body.path;
  if (!src) return c.json({ error: "Missing backup path" }, 400);
  if (!existsSync(src)) return c.json({ error: "Backup file not found" }, 404);
  const restored = await importBackup(src, { overwrite: body.overwrite ?? false });
  return c.json({ ok: true, restored });
});

apiRoutes.post("/api/admin/migrate", async (c) => {
  const dryRun = c.req.query("dryRun") === "true";
  if (dryRun) {
    return c.json({ dryRun: true, wouldMigrate: true });
  }
  const migrated = await migrateLegacyWorks();
  return c.json({ ok: true, migrated });
});

// ── Publish API ───────────────────────────────────────────────────────────
apiRoutes.route("/api/publish", publishRoutes);
// Phase 4b: Work-scoped publish routes (RPA: douyin/xiaohongshu/channels)
apiRoutes.route("/api/works/:id/publish", publishWorkRoutes);
apiRoutes.route("/api/accounts", accountsRoutes);
apiRoutes.route("/api/queue", queueRoutes);
apiRoutes.route("/api/calendar", calendarRoutes);
apiRoutes.route("/api/budget", budgetRoutes);
apiRoutes.route("/api/data-sources", dataSourceRoutes);
apiRoutes.route("/api/stock-assets", stockAssetRoutes);
