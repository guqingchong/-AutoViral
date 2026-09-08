/**
 * 模型粒度能力表（2026-09 改造项 L3）。
 *
 * 背景：kimi-coding 曾被 provider 粒度硬编码误标"无 vision"（改造方案的活教材），
 * 故本表一律按 modelId 粒度显式声明，绝不按 provider 推断。
 *
 * 设计：静态能力表（MODEL_VISION / MODEL_TOOLS）+ 进程内缓存 + 首次实测兜底。
 * - 静态表命中（含显式 false）→ 直接返回并写缓存；
 * - 静态表未命中 → 调 detectVisionByProbe/detectToolsByProbe 实测；
 *   - 探针返回 boolean → 写缓存并返回；
 *   - 探针返回 undefined（未实现/不可用）→ 保守 false，且【不写缓存】（下次仍走探测路径）。
 *
 * 约定：新增模型必须显式加表项，禁止用纯文本/纯代码推断推断视觉能力。
 */

/** 静态视觉能力表（模型粒度，modelId → 是否接受图片）。 */
export const MODEL_VISION: Record<string, boolean> = {
  "glm-5v-turbo": true,
  "glm-5.3-flash": true,
  "deepseek-v4-flash-vision-exp": true,
  // L1 验收修复(2026-09-07):降级链候选补显式声明——text-only 模型显式 false,
  // 防止 vision 评审降级到无看图能力的模型后评审必败。
  "glm-4.6": false,        // 文本模型(GLM-4.6V 才是视觉变体)
  "deepseek-v4-pro": false, // 【待核对】按 DeepSeek 文档保守 text-only,探针实测后回填
  "kimi-for-coding": false, // 【待核对】provider-keys.ts 把 visionModel 设为 kimi-for-coding，但实测未定——保守 false 待冒烟探针回填
};

/** 静态工具能力表（模型粒度，modelId → 是否支持工具调用）。
 *  kimi 支持内置工具（$web_search / 多轮回填），暂 true。 */
export const MODEL_TOOLS: Record<string, boolean> = {
  "kimi-for-coding": true,
};

/** 进程内视觉能力缓存（避免反复查表/探测）。 */
const visionCache = new Map<string, boolean>();

/** 进程内工具能力缓存。 */
const toolsCache = new Map<string, boolean>();

/** 探针在飞集合(防同一模型并发重复冒烟)。 */
const probeInFlight = new Set<string>();

/**
 * 视觉冒烟探针(X18' 实装,2026-09-07;此前为恒 undefined 的占位)。
 *
 * 策略:同步调用方不能等 HTTP,故本次保守返回 undefined(→false 且不写缓存),
 * 同时后台发一次"含 1px 图 + max_tokens=1"的最小 chat 请求,结果回填 visionCache,
 * 下次调用即命中实测值。判定规则:
 *  - 2xx → true(模型真实接受了 image_url 变体);
 *  - 400 且错误文本含 image/vision → false(无视觉模型的典型拒法);
 *  - 其他(401/429/5xx/超时)→ 无法判定,不写缓存(下次再探)。
 * provider 反查:llm_usage 实测记录(该模型历史调用走过哪个 provider);无记录则放弃。
 */
function detectVisionByProbe(modelId: string): boolean | undefined {
  if (probeInFlight.has(modelId)) return undefined;
  probeInFlight.add(modelId);
  void probeVisionAsync(modelId)
    .catch(() => {})
    .finally(() => probeInFlight.delete(modelId));
  return undefined;
}

async function probeVisionAsync(modelId: string): Promise<void> {
  const { getDb } = await import("../db/connection.js");
  const row = getDb()
    .prepare("SELECT provider FROM llm_usage WHERE model = ? ORDER BY ts DESC LIMIT 1")
    .get(modelId) as { provider?: string } | undefined;
  const providerKey = row?.provider;
  if (!providerKey) return;
  const [{ loadConfig }, { PROVIDER_PRESETS }] = await Promise.all([
    import("../config.js"),
    import("./provider-keys.js"),
  ]);
  const config = await loadConfig();
  const apiKey = config.llm?.providers?.[providerKey]?.apiKey;
  const baseUrl = config.llm?.providers?.[providerKey]?.baseUrl ?? PROVIDER_PRESETS[providerKey]?.baseUrl;
  if (!apiKey || !baseUrl) return;
  // 1x1 透明 PNG(最小合法图片)
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: px } },
          { type: "text", text: "hi" },
        ] }],
      }),
    });
    if (res.ok) { visionCache.set(modelId, true); return; }
    const text = await res.text().catch(() => "");
    if (res.status === 400 && /image|vision|image_url/i.test(text)) {
      visionCache.set(modelId, false);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 工具能力冒烟探针（占位，结构同 detectVisionByProbe）。
 *
 * 【待实现：工具冒烟探针】——对静态表未覆盖的 modelId 发一次带 tools 定义的最小
 * 工具调用请求，观察是否返回 tool_use。返回真值/未定语义与视觉探针一致。
 */
function detectToolsByProbe(modelId: string): boolean | undefined {
  void modelId;
  return undefined;
}

/**
 * 判断模型是否接受图片输入。
 *
 * 查询顺序：静态表 → 视觉冒烟探针；表内命中/探针定性后均写入进程内缓存。
 * 探针返回 undefined（未定）时不写缓存，且本次保守返回 false。
 */
export function modelSupportsImage(modelId: string): boolean {
  if (visionCache.has(modelId)) return visionCache.get(modelId)!;

  const declared = MODEL_VISION[modelId];
  if (declared !== undefined) {
    visionCache.set(modelId, declared);
    return declared;
  }

  const probed = detectVisionByProbe(modelId);
  if (probed === undefined) return false;
  visionCache.set(modelId, probed);
  return probed;
}

/**
 * 判断模型是否支持工具调用（结构同 modelSupportsImage）。
 */
export function supportsTools(modelId: string): boolean {
  if (toolsCache.has(modelId)) return toolsCache.get(modelId)!;

  const declared = MODEL_TOOLS[modelId];
  if (declared !== undefined) {
    toolsCache.set(modelId, declared);
    return declared;
  }

  const probed = detectToolsByProbe(modelId);
  if (probed === undefined) return false;
  toolsCache.set(modelId, probed);
  return probed;
}

/** 测试/热更新用：清空进程内能力缓存。 */
export function _resetCapabilityCache(): void {
  visionCache.clear();
  toolsCache.clear();
}
