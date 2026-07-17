import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createSnapshot } from "../db/trends-repo.js";
import { createTopic, listTopics } from "../db/topics-repo.js";
import { recordDataSourceReference } from "../db/data-sources-repo.js";
import type { DbTopic } from "../db/types.js";
import { resolveClaudeCommand } from "../ws-bridge.js";
import { buildTonePrompt } from "./tone-profile.js";

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = join(process.cwd(), "skills", "trend-research", "scripts");

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

export async function fetchTrendData(platform: string): Promise<string> {
  try {
    if (platform === "douyin") {
      const { stdout } = await execFileAsync(PYTHON_BIN, [join(SCRIPTS_DIR, "douyin_hot_search.py"), "--top", "30"], { timeout: 30000 });
      return stdout;
    }
    const { stdout } = await execFileAsync(PYTHON_BIN, [join(SCRIPTS_DIR, "newsnow_trends.py"), platform, "--top", "20"], { timeout: 30000 });
    return stdout;
  } catch (err) {
    console.error(`[trends] script error for ${platform} (cmd: ${PYTHON_BIN}):`, err instanceof Error ? err.message : err);
    return "";
  }
}

export async function collectTrends(platforms: string[], interests: string[] = [], toneProfile?: Record<string, unknown> | null): Promise<{ platform: string; topics: DbTopic[] }[]> {
  const results: { platform: string; topics: DbTopic[] }[] = [];

  // Gather all existing topic titles for dedup across all platforms
  const existingTopics = listTopics(undefined, 500);
  const existingTitles = new Set(existingTopics.map(t => t.title.trim().toLowerCase()));

  for (const platform of platforms) {
    const raw = await fetchTrendData(platform);
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
    const allTopics = await analyzeTrendsWithAgent(platform, raw, interests, snapshot.id, toneProfile);

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

    const created: DbTopic[] = [];
    for (const t of deduped) {
      const topic = createTopic({ ...t, snapshot_id: snapshot.id, status: "collected" });
      created.push(topic);
      existingTitles.add(t.title.trim().toLowerCase());
      // PRD 4.1.1: track external data sources referenced via WebSearch; promote to fixed after 5+ references
      if (t.source_url) {
        try { recordDataSourceReference({ url: t.source_url, platform, title: t.title }); } catch { /* ignore tracking errors */ }
      }
    }
    console.log(`[trends] ${platform}: collected ${allTopics.length} topics, ${deduped.length} new after dedup`);
    results.push({ platform, topics: created });
  }
  return results;
}

function analyzeTrendsWithAgent(platform: string, rawData: string, interests: string[], snapshotId: number, toneProfile?: Record<string, unknown> | null): Promise<Omit<DbTopic, "id" | "created_at" | "status">[]> {
  return new Promise((resolve) => {
    const platformLabel = platform === "xiaohongshu" ? "小红书" : platform === "douyin" ? "抖音" : platform;
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
          `3. 如果某个关注领域在当前平台热搜中完全没有相关条目，请用 WebSearch 深度搜索该领域，而不是用泛热门话题填充`,
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
      ? `\n以下是通过 API 获取的 ${platformLabel} 实时热搜数据。请先从中筛选出与用户关注领域直接相关的条目（如果没有则跳过）。然后**必须使用 WebSearch 工具**搜索以下关键词，每个关键词一次独立搜索，补充领域专属内容：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}"`}\n\n**重要**：WebSearch 搜索是关键步骤，不要跳过。用户关注领域的热门话题通常不在泛热搜榜上，必须通过定向搜索获取。\n\n热搜原始数据：\n\`\`\`json\n${rawData.slice(0, 3000)}\n\`\`\`\n`
      : `\n无法通过 API 获取实时数据。请使用 WebSearch 按以下关键词搜索（每个关键词一次独立搜索）：\n${interestSearchTerms || `"${platformLabel} 爆款内容 趋势 ${year}" "${platformLabel} 热门话题 最新 ${year}"`}\n${interests.length ? `\n**注意**：搜索结果必须围绕用户关注领域展开。不要返回与用户领域无关的泛热门内容。` : ""}\n`;
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
      `- topics 至少 15 个，不够就多搜多看，每个角度都可以成为一个独立话题`,
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

    const cli = resolveClaudeCommand();
    console.log(`[trends] spawning Claude CLI for ${platformLabel} (cli=${cli}, interests=[${interests.join(",")}])`);
    const proc = spawn(cli, ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--model", "sonnet"], {
      cwd: process.env.HOME ?? process.cwd(),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    // Close stdin immediately to prevent 3s wait
    try { proc.stdin?.end(); } catch { /* ignore */ }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("exit", (code) => {
      if (code !== 0 || stderr) {
        console.error(`[trends] Claude CLI exit code=${code}, stderr=${stderr.slice(0, 500)}`);
      }
      try {
        const envelope = JSON.parse(stdout);
        const text = (envelope.result ?? "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        if (first < 0 || last <= first) {
          console.error(`[trends] Claude CLI returned no JSON object. result preview: ${text.slice(0, 200)}`);
          return resolve([]);
        }
        const parsed = JSON.parse(text.slice(first, last + 1));
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
        console.log(`[trends] Claude CLI returned ${topics.length} topics for ${platformLabel}`);
        resolve(topics);
      } catch (err) {
        console.error(`[trends] Claude CLI JSON parse error:`, err instanceof Error ? err.message : err);
        console.error(`[trends] stdout preview:`, stdout.slice(0, 1000));
        resolve([]);
      }
    });
    proc.on("error", (err) => {
      console.error(`[trends] Claude CLI spawn error:`, err.message);
      resolve([]);
    });
    setTimeout(() => { try { proc.kill(); } catch {} resolve([]); }, 180000);
  });
}

export { listTopics, getTopic } from "../db/topics-repo.js";
