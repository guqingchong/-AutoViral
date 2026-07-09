import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createSnapshot } from "../db/trends-repo.js";
import { createTopic, listTopics } from "../db/topics-repo.js";
import type { DbTopic } from "../db/types.js";
import { resolveClaudeCommand } from "../ws-bridge.js";

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

export async function collectTrends(platforms: string[], interests: string[] = []): Promise<{ platform: string; topics: DbTopic[] }[]> {
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
    const topics = await analyzeTrendsWithAgent(platform, raw, interests, snapshot.id);
    const created: DbTopic[] = [];
    for (const t of topics) {
      created.push(createTopic({ ...t, snapshot_id: snapshot.id, status: "collected" }));
    }
    results.push({ platform, topics: created });
  }
  return results;
}

function analyzeTrendsWithAgent(platform: string, rawData: string, interests: string[], snapshotId: number): Promise<Omit<DbTopic, "id" | "created_at" | "status">[]> {
  return new Promise((resolve) => {
    const platformLabel = platform === "xiaohongshu" ? "小红书" : platform === "douyin" ? "抖音" : platform;
    const interestClause = interests.length ? `用户关注领域：${interests.join("、")}` : "";
    const dataClause = rawData ? `实时热搜数据：\n${rawData.slice(0, 4000)}` : "无 API 数据，请使用 WebSearch 搜索最新趋势。";
    const prompt = [
      `你是社交媒体趋势研究员。分析 ${platformLabel} 当前热门内容趋势。`,
      dataClause,
      interestClause,
      `输出严格 JSON（不要 Markdown）：`,
      JSON.stringify({
        topics: [{
          title: "话题标题",
          heat: 4,
          competition: "中",
          opportunity: "金矿",
          emotionType: "焦虑",
          emotionSubtype: "被替代焦虑",
          description: "趋势描述",
          tags: ["标签1"],
          contentAngles: ["切入角度1"],
          exampleHook: "爆款开头示例",
          category: "所属领域",
        }],
      }, null, 2),
      `要求：topics 至少 10 个；heat 1-5；competition 低/中/高；opportunity 金矿/蓝海/红海；emotionType 焦虑/愤怒/搞笑/羡慕；tags 3-5 个；contentAngles 2-3 个。`,
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
