/**
 * 模型画像（2026-09 改造项 L1）。
 *
 * 背景：pickFallbackEvalModel（api.ts）此前写死降级到 glm-5.3-flash，实测最慢
 * （70~113s/次）。本模块从 llm_usage 表实时聚合各 model 的延迟，叠加静态成本/能力
 * 画像，供降级链按"同能力 + 延迟最低"选可用模型（当前应选中 kimi，而非 glm）。
 *
 * 画像五元：latency（llm_usage 聚合）/ cost（COST_CATALOG）/ vision / tools / webSearch。
 */
import { getDb } from "../db/connection.js";
import { modelSupportsImage, supportsTools } from "./capability.js";

/**
 * 单模型画像。
 * - latencyMs：llm_usage 表该 model 的平均调用墙钟（毫秒）；无样本时为 NaN
 * - costPerMToken：每百万 token 代表性单价（取 COST_CATALOG input 价作为比较基准，
 *   完整输入/输出价见 COST_CATALOG）
 * - vision / tools / webSearch：能力布尔（来自 capability.ts / MODEL_WEB_SEARCH）
 */
export interface ModelProfile {
  model: string;
  provider: string;
  latencyMs: number;
  costPerMToken: number;
  vision: boolean;
  tools: boolean;
  webSearch: boolean;
}

/**
 * 每百万 token 刊例价（元，输入/输出）。按 provider 粒度粗分。
 *
 * 【待与定价表核对】——数值为施工图给定参考值，需与 config.llm.priceTable 及
 * llm-usage.ts 内置刊例（DEFAULT_PRICE_TABLE）对齐；当前可能过时或与按 model 细粒度的
 * 定价不一致（例如 glm-5.3-flash 在 llm-usage.ts 已按 1.1/3.6 定价，此处 glm 档为 0/0）。
 */
export const COST_CATALOG: Record<string, { input: number; output: number }> = {
  deepseek: { input: 0.14, output: 0.28 },
  kimi: { input: 0.6, output: 2.5 },
  glm: { input: 0, output: 0 },
};

/**
 * webSearch 能力表（模型粒度）。kimi 有内置 $web_search 联网工具（provider-keys.ts）。
 *
 * 【待核对】deepseek / glm 的联网能力未实证，保守 false。
 */
const MODEL_WEB_SEARCH: Record<string, boolean> = {
  "kimi-for-coding": true,
};

/**
 * 从 llm_usage 表聚合出各 model 的画像。
 *
 * - latency：按 (provider, model) 分组取 AVG(latency_ms)；无样本时为 NaN
 * - cost：从 COST_CATALOG 按 provider 取 input 单价（比较基准）
 * - vision / tools / webSearch：分别由 modelSupportsImage / supportsTools / MODEL_WEB_SEARCH 决定
 */
export async function loadModelProfiles(): Promise<ModelProfile[]> {
  const rows = getDb()
    .prepare(
      `SELECT provider, model, AVG(latency_ms) AS avg_latency_ms
       FROM llm_usage
       WHERE latency_ms IS NOT NULL
       GROUP BY provider, model`,
    )
    .all() as Array<{ provider: string; model: string; avg_latency_ms: number | null }>;

  return rows.map((r) => {
    const price = COST_CATALOG[r.provider];
    return {
      model: r.model,
      provider: r.provider,
      latencyMs: r.avg_latency_ms ?? NaN,
      costPerMToken: price ? price.input : NaN,
      vision: modelSupportsImage(r.model),
      tools: supportsTools(r.model),
      webSearch: MODEL_WEB_SEARCH[r.model] ?? false,
    };
  });
}

/**
 * 按画像选择满足需求且延迟最低的可用模型。
 *
 * 过滤：need.vision 为 true 时仅留 m.vision=true；need.webSearch 为 true 时仅留
 * m.webSearch=true；两者缺省时不施加对应约束。
 * 排序：latencyMs 升序；latency 为 NaN（无样本）的模型排到最后。
 * 返回：首个候选 ModelProfile；无候选时 undefined。
 */
export function pickByProfile(
  models: ModelProfile[],
  need: { vision?: boolean; webSearch?: boolean },
): ModelProfile | undefined {
  const candidates = models
    .filter((m) => (!need.vision || m.vision) && (!need.webSearch || m.webSearch))
    .sort((a, b) => rankLatency(a) - rankLatency(b));
  return candidates[0];
}

/** 延迟排序键：有样本用 latencyMs，无样本（NaN）视为最大（排最后）。 */
function rankLatency(m: ModelProfile): number {
  return Number.isFinite(m.latencyMs) ? m.latencyMs : Number.MAX_SAFE_INTEGER;
}
