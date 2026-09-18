/**
 * DeepSeek 家族模型路由自动更新（2026-09-10）。
 *
 * 背景：官方模型目录随发布滚动变化。2026-09-10 V4.1 Flash 正式上线后，公开 API
 * `GET /models` 目录收敛为 `deepseek-flash` / `deepseek-v4-pro`——实测 400 报错亦
 * 确认官方【不存在】"deepseek-v4.1-flash" 这个 model 名（V4.1 Flash 以
 * `deepseek-flash` 之名服务，`deepseek-v4-flash` 是其历史别名，三者返回的
 * model 字段均为 deepseek-flash）。设置页阶段路由若继续硬编码必然漂移，故改为：
 *
 *   启动 + 每 6h 后台拉取官方目录 → 过滤排除清单 → 写缓存（内存 + 磁盘）；
 *   presentLlm 同步读缓存；拉取失败保留上次缓存；从未成功则回退
 *   provider-keys.ts 静态兜底——网络抖动永远不影响设置页出选项。
 *
 * 排除清单源于 2026-09-10 用户指令：设置页删除 deepseek-v4-pro /
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp 三个选项，只保留
 * V4.1 Flash（deepseek-flash）。清单落在代码而非手删 yaml，官方上新模型
 * （如未来 V5）仍会自动出现在下拉里。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDER_PRESETS } from "./provider-keys.js";
import { dataDir } from "../config.js";

const CACHE_FILE = join(dataDir, "deepseek-models.json");
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const FETCH_TIMEOUT_MS = 15_000;

/** 用户 2026-09-10 要求从设置页移除的模型（官方目录若仍返回则过滤掉）。 */
const EXCLUDED = new Set([
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

interface DeepseekModelCache {
  updatedAt: number;
  modelIds: string[];
}

let memory: DeepseekModelCache | undefined;
let diskLoaded = false;

/**
 * 设置页建议清单（同步读）：内存 → 磁盘缓存 → provider-keys 静态兜底。
 * 供 presentLlm 这类同步调用方使用；刷新由 scheduleDeepseekModelRefresh 驱动。
 */
export function getDeepseekModelSuggestions(): string[] {
  if (!diskLoaded) {
    diskLoaded = true;
    void loadDiskCache()
      .then((c) => { memory ??= c; })
      .catch(() => { /* 读盘失败走兜底 */ });
  }
  const ids = memory?.modelIds;
  return ids && ids.length ? ids : (PROVIDER_PRESETS.deepseek.modelSuggestions ?? []);
}

async function loadDiskCache(): Promise<DeepseekModelCache | undefined> {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as Partial<DeepseekModelCache>;
    if (Array.isArray(raw?.modelIds)) {
      const modelIds = raw.modelIds.filter((x): x is string => typeof x === "string" && x !== "" && !EXCLUDED.has(x));
      if (modelIds.length) return { updatedAt: Number(raw.updatedAt) || 0, modelIds };
    }
  } catch { /* 首次运行无缓存文件 */ }
  return undefined;
}

/**
 * 拉取官方 `GET {baseUrl}/models` 并刷新缓存。
 * 无 apiKey（未配置）时直接跳过——请求必 401，保留旧缓存/兜底即可；
 * 网络失败、非 2xx、目录为空一律不覆盖既有缓存（宁陈旧，不出空白下拉）。
 */
export async function refreshDeepseekModels(apiKey?: string, baseUrl?: string): Promise<void> {
  if (!apiKey) return;
  const base = (baseUrl || PROVIDER_PRESETS.deepseek.baseUrl).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter((id) => id !== "" && !EXCLUDED.has(id));
    if (!ids.length) return;
    memory = { updatedAt: Date.now(), modelIds: ids };
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(memory, null, 2), "utf-8");
    } catch { /* 写盘失败仅降级为进程内缓存，不影响功能 */ }
    console.log(`[deepseek-models] 官方目录已刷新：${ids.join(", ")}`);
  } catch {
    /* 网络/超时/JSON 异常：静默保留旧缓存 */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 服务启动挂钩（server/index.ts 后台服务区调用）。
 * creds 取 getter 而非快照——PUT /api/config 换 key 后下一轮刷新即用新凭据。
 */
export function scheduleDeepseekModelRefresh(creds: () => { apiKey?: string; baseUrl?: string }): void {
  void (async () => {
    diskLoaded = true;
    try {
      const c = await loadDiskCache();
      if (c) memory = c;
    } catch { /* 无磁盘缓存 */ }
    try {
      await refreshDeepseekModels(creds().apiKey, creds().baseUrl);
    } catch { /* 首轮失败不致命 */ }
  })();
  const t = setInterval(() => {
    void refreshDeepseekModels(creds().apiKey, creds().baseUrl).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  t.unref(); // 定时器不阻止进程退出
}
