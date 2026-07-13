import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createSnapshot } from "../db/trends-repo.js";
import { createTopic, listTopics } from "../db/topics-repo.js";
import type { DbTopic } from "../db/types.js";
import { resolveClaudeCommand } from "../ws-bridge.js";
import { buildTonePrompt } from "./tone-profile.js";

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = join(process.cwd(), "skills", "trend-research", "scripts");

export async function fetchTrendData(platform: string): Promise<string> {
  try {
    if (platform === "douyin") {
      const { stdout } = await execFileAsync("python3", [join(SCRIPTS_DIR, "douyin_hot_search.py"), "--top", "30"], { timeout: 30000 });
      return stdout;
    }
    const { stdout } = await execFileAsync("python3", [join(SCRIPTS_DIR, "newsnow_trends.py"), platform, "--top", "20"], { timeout: 30000 });
    return stdout;
  } catch (err) {
    console.error(`[trends] script error for ${platform}:`, err);
    return "";
  }
}

export async function collectTrends(platforms: string[], interests: string[] = [], toneProfile?: Record<string, unknown> | null): Promise<{ platform: string; topics: DbTopic[] }[]> {
  const results: { platform: string; topics: DbTopic[] }[] = [];
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
    const topics = await analyzeTrendsWithAgent(platform, raw, interests, snapshot.id, toneProfile);
    const created: DbTopic[] = [];
    for (const t of topics) {
      created.push(createTopic({ ...t, snapshot_id: snapshot.id, status: "collected" }));
    }
    results.push({ platform, topics: created });
  }
  return results;
}

function analyzeTrendsWithAgent(platform: string, rawData: string, interests: string[], snapshotId: number, toneProfile?: Record<string, unknown> | null): Promise<Omit<DbTopic, "id" | "created_at" | "status">[]> {
  return new Promise((resolve) => {
    const platformLabel = platform === "xiaohongshu" ? "小红书" : platform === "douyin" ? "抖音" : platform;
    const interestClause = interests.length
      ? `\n用户特别关注以下领域：${interests.join("、")}。请优先覆盖这些领域的趋势，同时也包含其他热门方向。\n`
      : "";
    const dataClause = rawData
      ? `\n以下是通过 API 获取的 ${platformLabel} 实时热搜数据，请以此为基础进行分析：\n\`\`\`json\n${rawData.slice(0, 4000)}\n\`\`\`\n`
      : `\n无法通过 API 获取实时数据，请使用 WebSearch 搜索最新热搜信息。搜索："${platformLabel} 爆款内容 趋势 2026" "${platformLabel} 热门话题 最新"\n`;
    const tonePrefix = buildTonePrompt(toneProfile);
    const prompt = [
      `你是一个专业的社交媒体趋势研究员。请分析 ${platformLabel} 平台当前最热门的内容趋势。`,
      tonePrefix,
      dataClause,
      interestClause,
      ``,
      `## 核心创作方向（强制执行）`,
      ``,
      `每个推荐的话题/方向必须能触发以下四种情绪中的至少一种，否则不予推荐：`,
      `1. **焦虑**（落后焦虑/错过焦虑/被替代焦虑/身份下坠焦虑）— 让观众觉得"我是不是落后了"`,
      `2. **愤怒**（不公/冒犯/双标/欺骗/价值观冲突）— 让观众觉得"这不对/凭什么"`,
      `3. **搞笑/抽象**（反转/共鸣/错位）— 让观众笑出来想转发`,
      `4. **羡慕**（想成为/想拥有）— 让观众觉得"我也想要这样的生活"`,
      ``,
      `输出严格 JSON（不要 Markdown，只输出 JSON 对象）：`,
      JSON.stringify({
        topics: [{
          title: "话题标题",
          heat: 4,
          competition: "中",
          opportunity: "金矿",
          emotionType: "焦虑",
          emotionSubtype: "被替代焦虑",
          description: "趋势描述和为什么值得做",
          tags: ["推荐标签1", "推荐标签2", "推荐标签3"],
          contentAngles: ["切入角度1", "切入角度2", "切入角度3"],
          exampleHook: "一句话爆款开头示例",
          category: "所属领域",
        }],
      }, null, 2),
      ``,
      `## 输出约束`,
      `- topics 至少 10 个，不够就多搜多看`,
      `- heat 为 1-5 整数，5 = 现象级刷屏`,
      `- competition "低"/"中"/"高"——低竞争是蓝海机会`,
      `- opportunity "金矿"(高热低竞)/"蓝海"(低热低竞)/"红海"(高热高竞)`,
      `- emotionType 必填，为 "焦虑"/"愤怒"/"搞笑"/"羡慕" 之一`,
      `- emotionSubtype 必填，为该情绪的具体子类型`,
      `- tags 3-5 个`,
      `- contentAngles 2-3 个具体的内容切入角度`,
      `- exampleHook 一句话的爆款开头示例`,
      `- category 为所属领域（美食/科技/穿搭/生活/情感/职场/健身/旅行/宠物/教育）`,
    ].join("\n");

    const cli = resolveClaudeCommand();
    const proc = spawn(cli, ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--model", "haiku"], {
      cwd: process.env.HOME ?? process.cwd(),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.on("exit", () => {
      try {
        const envelope = JSON.parse(stdout);
        const text = (envelope.result ?? "").replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        if (first < 0 || last <= first) return resolve([]);
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
        resolve(topics);
      } catch {
        resolve([]);
      }
    });
    proc.on("error", () => resolve([]));
    setTimeout(() => { try { proc.kill(); } catch {} resolve([]); }, 120000);
  });
}

export { listTopics, getTopic } from "../db/topics-repo.js";
