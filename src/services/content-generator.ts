import { resolveClaudeCommand } from "../ws-bridge.js";
import { spawn } from "node:child_process";
import type { DbTopic } from "../db/types.js";
import { buildTonePrompt } from "./tone-profile.js";

export interface GeneratedArticle {
  title: string;
  content: string;
  platform: string;
}

export interface GeneratedScript {
  scenes: Array<{ timestamp: string; narration: string; visual: string }>;
  duration: number;
}

export interface ContentGenOptions {
  /** Account tone_profile JSON — injected as style instructions. */
  toneProfile?: Record<string, unknown> | null;
}

export async function generateArticleFromTopic(topic: DbTopic, platform: string, opts?: ContentGenOptions): Promise<GeneratedArticle> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const prompt = [
    tonePrefix,
    `根据以下选题，为 ${platform} 平台写一篇完整的中文文章/文案。`,
    `选题：${topic.title}`,
    `描述：${topic.description ?? ""}`,
    `情绪类型：${topic.emotion_type ?? ""} / ${topic.emotion_subtype ?? ""}`,
    `标签：${topic.tags.join(", ")}`,
    `切入角度：${topic.content_angles.join("；")}`,
    `爆款开头：${topic.example_hook ?? ""}`,
    `输出 JSON：{"title":"标题","content":"正文"}。content 为可直接发布的正文（含换行）。`,
  ].filter(Boolean).join("\n");
  return runJsonPrompt<GeneratedArticle>(prompt);
}

export async function generateScriptFromArticle(article: GeneratedArticle, duration = 180, opts?: ContentGenOptions): Promise<GeneratedScript> {
  const tonePrefix = buildTonePrompt(opts?.toneProfile);
  const prompt = [
    tonePrefix,
    `将以下文章改写成 ${Math.floor(duration / 60)} 分钟口播视频脚本。`,
    `标题：${article.title}`,
    `文章：${article.content}`,
    `输出 JSON：{"scenes":[{"timestamp":"0:00-0:15","narration":"口播文案","visual":"画面描述"}],"duration":${duration}}。`,
  ].filter(Boolean).join("\n");
  return runJsonPrompt<GeneratedScript>(prompt);
}

function runJsonPrompt<T>(prompt: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cli = resolveClaudeCommand();
    const proc = spawn(cli, ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--model", "sonnet"], {
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
        if (first < 0 || last <= first) return reject(new Error("No JSON object in agent output"));
        resolve(JSON.parse(text.slice(first, last + 1)) as T);
      } catch (err) {
        reject(err);
      }
    });
    proc.on("error", reject);
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("Content generation timeout")); }, 180000);
  });
}
