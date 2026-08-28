import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSnapshot } from "../db/trends-repo.js";
import { createTopic, listTopics } from "../db/topics-repo.js";
import { recordDataSourceReference } from "../db/data-sources-repo.js";
import type { DbTopic } from "../db/types.js";
import { loadConfig } from "../config.js";
import { resolveModelFor } from "../llm/registry.js";
import { PROVIDER_PRESETS } from "../llm/provider-keys.js";
import { chatJsonWithSearch } from "../llm/search-json.js";
import { buildTonePrompt } from "./tone-profile.js";
import { getTopicWeights } from "./feedback-loop.js";
import { fetchZhihuHotList, zhihuSearch } from "./zhihu-data-api.js";

const execFileAsync = promisify(execFile);
// 以模块位置推导项目根（dist/services 或 src/services 向上两级），
// 不能用 process.cwd()——服务以守护进程运行时 cwd 是用户主目录，脚本会找不到
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_DIR = join(PROJECT_ROOT, "skills", "trend-research", "scripts");

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

export async function fetchTrendData(platform: string, interests: string[] = []): Promise<string> {
  try {
    if (platform === "douyin") {
      const { stdout } = await execFileAsync(PYTHON_BIN, [join(SCRIPTS_DIR, "douyin_hot_search.py"), "--top", "30"], { timeout: 30000 });
      return stdout;
    }
    // 知乎：配置了数据平台 Secret 时优先官方热榜 + 关注领域搜索素材（失败/未配置退回 newsnow）
    if (platform === "zhihu") {
      const official = await fetchZhihuResearchData(interests);
      if (official) return official;
    }
    const { stdout } = await execFileAsync(PYTHON_BIN, [join(SCRIPTS_DIR, "newsnow_trends.py"), platform, "--top", "20"], { timeout: 30000 });
    return stdout;
  } catch (err) {
    console.error(`[trends] script error for ${platform} (cmd: ${PYTHON_BIN}):`, err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * 知乎官方数据：热榜 top20 + 每个关注领域站内搜索 top3。
 * 未配置 Secret 或接口失败时返回 null（调用方退回 newsnow）。
 */
async function fetchZhihuResearchData(interests: string[]): Promise<string | null> {
  try {
    const hotList = await fetchZhihuHotList(20);
    if (hotList.length === 0) return null; // 未配置 Secret 时为空，走降级
    const interestResults: Record<string, unknown[]> = {};
    for (const interest of interests.slice(0, 5)) {
      try {
        interestResults[interest] = await zhihuSearch(interest, 3);
      } catch {
        interestResults[interest] = [];
      }
    }
    return JSON.stringify({
      source: "zhihu-official-api",
      hotList,
      interestSearch: interestResults,
    });
  } catch (err) {
    console.error("[trends] zhihu official api error:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 单个平台的调研进度 */
export interface PlatformProgress {
  platform: string;
  status: "pending" | "running" | "done" | "error";
  count?: number;
  error?: string;
}

export interface CollectOptions {
  /** 全局 TopN：按综合分排序后最终入库的选题数量（0/缺省 = 不限） */
  topN?: number;
  /** 每平台进度回调（供任务跟踪/前端轮询） */
  onProgress?: (progress: PlatformProgress[]) => void;
}

/**
 * 综合评分：匹配度已由提示词强制（围绕关注领域），此处按 热度/机会/竞争 排序。
 * 热度×2 + 机会权重（金矿3/蓝海2/红海1）+ 竞争权重（低2/中1/高0）
 */
export function topicScore(t: { heat?: number | string; opportunity?: string; competition?: string }): number {
  const heat = Number(t.heat) || 0;
  const opp = t.opportunity === "金矿" ? 3 : t.opportunity === "蓝海" ? 2 : t.opportunity === "红海" ? 1 : 0;
  const comp = t.competition === "低" ? 2 : t.competition === "中" ? 1 : 0;
  return heat * 2 + opp + comp;
}

/** 采集中标志(2026-08-28 批次5.4):定时调度与手动触发共用此函数,此前无互斥——
 *  重叠触发 = 重复选题 + 双倍 LLM 开销 */
let collectRunning = false;

export async function collectTrends(platforms: string[], interests: string[] = [], toneProfile?: Record<string, unknown> | null, opts: CollectOptions = {}): Promise<{ platform: string; topics: DbTopic[] }[]> {
  if (collectRunning) throw new Error("选题采集正在进行中,请勿重复触发(定时与手动采集互斥)");
  collectRunning = true;
  try {
    return await collectTrendsInner(platforms, interests, toneProfile, opts);
  } finally {
    collectRunning = false;
  }
}

async function collectTrendsInner(platforms: string[], interests: string[] = [], toneProfile?: Record<string, unknown> | null, opts: CollectOptions = {}): Promise<{ platform: string; topics: DbTopic[] }[]> {
  // 每个平台预置结果桶（即使 0 条候选也返回空桶，保持调用方契约）
  const results: { platform: string; topics: DbTopic[] }[] = platforms.map(p => ({ platform: p, topics: [] }));

  // Gather all existing topic titles for dedup across all platforms
  const existingTopics = listTopics(undefined, 500);
  const existingTitles = new Set(existingTopics.map(t => t.title.trim().toLowerCase()));

  const progress: PlatformProgress[] = platforms.map(p => ({ platform: p, status: "pending" }));
  const report = () => opts.onProgress?.(progress.map(p => ({ ...p })));
  report();

  // 全局候选池（topN 跨平台统一排序截断）
  const candidates: Omit<DbTopic, "id" | "created_at" | "status">[] = [];

  /** 单平台采集+分析（内部异常自捕获，不影响其他平台） */
  async function collectOne(platform: string): Promise<void> {
    const p = progress.find(x => x.platform === platform)!;
    p.status = "running";
    report();
    try {
      const raw = await fetchTrendData(platform, interests);
      // 2026-08-28 批次5.1 幻觉闸:采集失败(脚本异常/网络断)且无内置搜索能力时,
      // LLM 会凭先验编造"最新趋势"照常入库(v2 病根 0)——拦在分析前,平台标 error
      // 透出到任务 error 与前端,宁缺毋假。
      if (!raw) {
        const config = await loadConfig();
        const { provider } = resolveModelFor(config, "research");
        const hasSearch = !!PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
        if (!hasSearch) {
          p.status = "error";
          p.error = "热搜采集失败且当前 research 模型无联网搜索能力,已拦截(防幻觉选题入库)。" +
            "请检查采集脚本,或为 research 档配置 kimi(内置 $web_search)后重试";
          report();
          return;
        }
      }
      const snapshotDate = new Date().toISOString().slice(0, 10);
      let parsedRaw: Record<string, unknown> = {};
      if (raw) {
        try {
          parsedRaw = JSON.parse(raw);
        } catch {
          parsedRaw = { raw };
        }
      }
      const snapshot = createSnapshot({ platform, snapshot_date: snapshotDate, raw_data: parsedRaw });
      // 2026-08-28 批次5.4 topN 前置:按 topN×1.5/平台数 生成(下限 5),
      // 不再"每平台 ≥15 个然后 topN=10 截断、90% 生成直接丢弃"
      const perPlatformTarget = opts.topN && opts.topN > 0
        ? Math.max(5, Math.ceil((opts.topN * 1.5) / platforms.length))
        : 15;
      const allTopics = await analyzeTrendsWithAgent(platform, raw, interests, snapshot.id, toneProfile, perPlatformTarget);

      // Dedup: skip topics whose title already exists (case-insensitive) or is too similar
      const deduped = allTopics.filter(t => {
        const titleLower = t.title.trim().toLowerCase();
        if (existingTitles.has(titleLower)) return false;
        // Check for near-duplicates: if >60% of words overlap with an existing title, skip
        const words = titleLower.split(/[\s,，。、]+/).filter((w: string) => w.length >= 2);
        if (words.length > 0) {
          for (const existing of existingTopics) {
            const exWords = existing.title.toLowerCase().split(/[\s,，。、]+/).filter((w: string) => w.length >= 2);
            const exSet = new Set(exWords);
            const overlap = words.filter(w => exSet.has(w)).length;
            const ratio = overlap / Math.max(words.length, exWords.length);
            if (ratio > 0.6) return false;
          }
        }
        return true;
      });
      for (const t of deduped) {
        candidates.push({ ...t, snapshot_id: snapshot.id });
      }
      p.status = "done";
      p.count = deduped.length;
      console.log(`[trends] ${platform}: collected ${allTopics.length} topics, ${deduped.length} new after dedup`);
    } catch (err) {
      p.status = "error";
      p.error = err instanceof Error ? err.message : String(err);
      console.error(`[trends] ${platform} failed:`, p.error);
    }
    report();
  }

  // 并发 3 路：串行时 7 平台 × 每平台数分钟 = 数十分钟，用户无从等待；
  // 并发过高会触发 Claude API 限流，3 是稳妥值
  const CONCURRENCY = 3;
  for (let i = 0; i < platforms.length; i += CONCURRENCY) {
    await Promise.all(platforms.slice(i, i + CONCURRENCY).map(collectOne));
  }

  // 全局 TopN：综合分降序，同分优先热度；截断后按平台分组入库
  // P3-T4 数据回流:品类×情绪 的历史三率权重修正综合分(样本<2 的组合权重恒 1)
  const feedbackWeights = getTopicWeights();
  const weightOf = (t: { category?: string; emotion_type?: string }) => {
    const w = feedbackWeights.find((x) => x.category === t.category && (!t.emotion_type || x.emotionType === t.emotion_type));
    return w && w.samples >= 2 ? w.weight : 1;
  };
  const scored = (t: (typeof candidates)[number]) => topicScore(t) * weightOf(t);
  const ranked = [...candidates].sort((a, b) => scored(b) - scored(a) || (Number(b.heat) || 0) - (Number(a.heat) || 0));
  const finalTopics = opts.topN && opts.topN > 0 ? ranked.slice(0, opts.topN) : ranked;

  for (const t of finalTopics) {
    const topic = createTopic({ ...t, status: "collected" });
    existingTitles.add(t.title.trim().toLowerCase());
    // PRD 4.1.1: track external data sources referenced via WebSearch; promote to fixed after 5+ references
    if (t.source_url) {
      try { recordDataSourceReference({ url: t.source_url, platform: t.platform, title: t.title }); } catch { /* ignore tracking errors */ }
    }
    const bucket = results.find(r => r.platform === t.platform);
    if (bucket) bucket.topics.push(topic);
  }
  report();
  return results;
}

async function analyzeTrendsWithAgent(platform: string, rawData: string, interests: string[], snapshotId: number, toneProfile?: Record<string, unknown> | null, targetCount = 15): Promise<Omit<DbTopic, "id" | "created_at" | "status">[]> {
    const PLATFORM_LABELS: Record<string, string> = {
      xiaohongshu: "小红书", douyin: "抖音", bilibili: "B站",
      zhihu: "知乎", kuaishou: "快手", channels: "视频号", wechat_mp: "微信公众号",
    };
    const platformLabel = PLATFORM_LABELS[platform] ?? platform;
    // BUGFIX: 用户关注领域是搜索和推荐的第一驱动力，不能被情绪模板覆盖
    const interestClause = interests.length
      ? [
          ``,
          `## 用户关注领域（核心驱动 — 最高优先级）`,
          ``,
          `用户指定了以下关注领域：**${interests.join("、")}**`,
          ``,
          `**强制规则：**`,
          `1. **100% 的推荐话题必须直接属于用户关注的领域或其紧密相关子领域。禁止返回任何与关注领域无关的泛热门话题。**`,
          `2. 每个关注领域至少覆盖 3-5 个话题。如果一个领域太大（如"科技"），请拆分为具体子方向（如 AI、芯片、新能源、自动驾驶）`,
          `3. 如果某个关注领域在当前平台热搜中完全没有相关条目，请用联网搜索深度搜索该领域，而不是用泛热门话题填充`,
          `4. 每个话题的 title 中必须包含该关注领域的具体关键词，不能是泛化的"热门话题"`,
          `5. 如果用户领域偏专业/技术（如"芯片制造""量子计算"），用该领域的专业视角找趋势，不要强行套用娱乐化情绪模板`,
        ].join("\n")
      : "";
    // BUGFIX: 搜索关键词必须包含用户关注领域
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
    const dataClause = rawData
      ? `\n以下是通过 API 获取的 ${platformLabel} 实时热搜数据。请先从中筛选出与用户关注领域直接相关的条目（如果没有则跳过）。然后**必须使用联网搜索工具**搜索以下关键词，每个关键词一次独立搜索，补充领域专属内容：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}"`}\n\n**重要**：联网搜索是关键步骤，不要跳过。用户关注领域的热门话题通常不在泛热搜榜上，必须通过定向搜索获取。\n\n热搜原始数据：\n\`\`\`json\n${rawData.slice(0, 3000)}\n\`\`\`\n`
      : `\n无法通过 API 获取实时数据。请使用联网搜索按以下关键词搜索（每个关键词一次独立搜索）：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}" "${platformLabel} 热门话题 最新 ${year}"`}\n${interests.length ? `\n**注意**：搜索结果必须围绕用户关注领域展开。不要返回与用户领域无关的泛热门内容。` : ""}\n`;
    const tonePrefix = buildTonePrompt(toneProfile);
    const prompt = [
      `你是一个专业的社交媒体趋势研究员。请分析 ${platformLabel} 平台上用户关注领域的最新内容趋势。`,
      tonePrefix,
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
      `当话题自然契合以下情绪时，标注对应的 emotionType。如果话题不适合任何情绪框架（如纯知识科普、技术教程），emotionType 填 "信息价值"，emotionSubtype 填具体的信息类型：`,
      `- **焦虑**：落后焦虑/错过焦虑/被替代焦虑 — 仅当话题自带紧迫感时使用`,
      `- **愤怒**：不公/双标/价值观冲突 — 仅当话题涉及争议时使用`,
      `- **搞笑**：反转/共鸣/错位 — 仅当话题有幽默元素时使用`,
      `- **羡慕**：想成为/想拥有 — 仅当话题展示理想生活/成就时使用`,
      `- **信息价值**：教程/科普/行业分析/深度解读/数据洞察 — 知识类话题的默认情绪类型`,
      ``,
      `输出严格 JSON（不要 Markdown，只输出 JSON 对象）：`,
      JSON.stringify({
        topics: [{
          title: "话题标题（必须体现具体领域关键词）",
          heat: 4,
          competition: "中",
          opportunity: "金矿",
          emotionType: "信息价值",
          emotionSubtype: "行业分析",
          description: "趋势描述和为什么值得做",
          tags: ["推荐标签1", "推荐标签2", "推荐标签3"],
          contentAngles: ["切入角度1", "切入角度2", "切入角度3"],
          exampleHook: "一句话爆款开头示例",
          category: "所属领域",
        }],
      }, null, 2),
      ``,
      `## 输出约束`,
      `- topics 目标 ${targetCount} 个(按全局 topN 前置计算,宁精勿滥;确实不够可少,禁止凑数灌水)`,
      `- heat 为 1-5 整数，5 = 现象级刷屏`,
      `- competition "低"/"中"/"高"——低竞争是蓝海机会`,
      `- opportunity "金矿"(高热低竞)/"蓝海"(低热低竞)/"红海"(高热高竞)`,
      `- emotionType 必填。优先使用 "焦虑"/"愤怒"/"搞笑"/"羡慕"/"信息价值"，如果都不适用则填最接近的一个并加注释`,
      `- emotionSubtype 必填，为该情绪/信息价值的具体子类型`,
      `- tags 3-5 个，必须包含用户关注领域的相关关键词`,
      `- contentAngles 2-3 个具体的内容切入角度，必须从用户关注领域出发`,
      `- exampleHook 一句话的爆款开头示例，必须体现领域特色`,
      `- category 为所属领域，优先使用用户关注领域中的分类`,
      `- **如果用户关注领域较专业，topics 中技术/行业类话题应占比 ≥ 70%**`,
    ].join("\n");

    // 2026-08-18 P3-T1：spawn Claude CLI → LLM 直连（research 档 + 平台内置搜索）
    const config = await loadConfig();
    const { provider, model } = resolveModelFor(config, "research");
    const builtinSearchTool = PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
    console.log(`[trends] ${platformLabel} 趋势调研 → ${provider.name}:${model}${builtinSearchTool ? `(内置搜索:${builtinSearchTool})` : "(无内置搜索,退化为单发)"}`);
    try {
      const parsed = await chatJsonWithSearch<{ topics?: any[] }>(provider, model, prompt, {
        timeoutMs: 480_000, // 8 分钟：深度调研要求多轮搜索，3 分钟必被腰斩
        maxRounds: 12,
        builtinSearchTool,
      });
      const topics = (parsed.topics ?? []).map((t: any) => ({
        platform,
        title: String(t.title ?? ""),
        description: String(t.description ?? ""),
        heat: Number(t.heat) || 1,
        competition: String(t.competition ?? "中"),
        opportunity: String(t.opportunity ?? "蓝海"),
        emotion_type: String(t.emotionType ?? ""),
        emotion_subtype: String(t.emotionSubtype ?? ""),
        tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
        content_angles: Array.isArray(t.contentAngles) ? t.contentAngles.map(String) : [],
        example_hook: String(t.exampleHook ?? ""),
        category: String(t.category ?? ""),
        source_url: String(t.sourceUrl ?? ""),
      }));
      console.log(`[trends] ${provider.name} returned ${topics.length} topics for ${platformLabel}`);
      return topics;
    } catch (err) {
      console.error(`[trends] 趋势调研失败(${platformLabel}):`, err instanceof Error ? err.message : err);
      // 2026-08-19 P1:不再吞成"成功 0 条"——失败必须抛出让平台任务落 error 态,
      // 否则模型未配/配额尽/超时全部表现为"调研完成 0 条",用户反复点反复烧钱
      throw err;
    }
}

export { listTopics, getTopic } from "../db/topics-repo.js";
