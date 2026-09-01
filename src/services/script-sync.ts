/**
 * 成片口播回写 scripts 表(2026-09-01 "DB 脚本与成片文案不同源"修复)
 *
 * 病根:assembly 阶段 agent 会现场重写口播,但最终文本只存在于
 * narration.mp3 / output/*.ass(ASR 回识别)里,scripts 表留的是 plan 前
 * 预生成的旧稿——下游(数字人 TTS、发布配文、复盘)读到的与成片说的不一致。
 *
 * 修复策略:assembly 门禁通过后调用 syncFinalNarrationToScript:
 *  ① 优先读 output/narration-final.md(契约要求 agent 落盘的最终口播全文)
 *  ② 兜底从最新的 output/*.ass 字幕提取纯文本(= 成片实际说的话,ASR 事实源)
 * 写回 scripts.content.narration(extractNarration 的 NARRATION_KEYS 首位,
 * 下游自动读到最终稿),原 scenes 结构保留备查。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getScript, updateScriptContent } from "../db/scripts-repo.js";

/** 从 ass 字幕提取纯文本:只取 Dialogue 行第 10 段,去 {\...} 标签与 \N 换行 */
export function assToText(ass: string): string {
  const texts: string[] = [];
  for (const line of ass.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    const parts = line.split(",");
    if (parts.length < 10) continue;
    const t = parts
      .slice(9)
      .join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, "")
      .replace(/\\h/g, " ")
      .trim();
    if (t) texts.push(t);
  }
  // 中文口播逐行拼接不加空格(英文词间空格由 ASR 词流自带)
  return texts.join("");
}

export interface NarrationSyncResult {
  synced: boolean;
  source?: string;
  length?: number;
}

export function syncFinalNarrationToScript(workDir: string, scriptId?: number | null): NarrationSyncResult {
  if (!scriptId) return { synced: false };
  const outDir = join(workDir, "output");

  let text = "";
  let source = "";
  // 2026-09-01 终审 M3:时效校验——narration-final.md 若早于成片 final.mp4,
  // 是上一轮的旧稿(重渲染后未重写),降级走 ass 兜底
  const finalVideo = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => /^final/i.test(f) && /\.(mp4|mov|webm)$/i.test(f))
        .map((f) => join(outDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined;
  const finalMtime = finalVideo ? statSync(finalVideo).mtimeMs : 0;

  const finalMd = join(outDir, "narration-final.md");
  if (existsSync(finalMd) && statSync(finalMd).mtimeMs >= finalMtime) {
    text = readFileSync(finalMd, "utf-8").trim();
    source = "narration-final.md";
  }
  if (!text && existsSync(outDir)) {
    // M3:ass 优先取与成片同族的 final*.ass(实际烧录版),其次才按 mtime 最新
    const assFiles = readdirSync(outDir).filter((f) => f.toLowerCase().endsWith(".ass"));
    const finalAss = assFiles.filter((f) => /^final/i.test(f));
    const newestAss = (finalAss.length ? finalAss : assFiles)
      .map((f) => join(outDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (newestAss) {
      text = assToText(readFileSync(newestAss, "utf-8")).trim();
      source = basename(newestAss);
    }
  }
  if (!text) return { synced: false };

  const script = getScript(scriptId);
  if (!script) return { synced: false };
  const content =
    script.content && typeof script.content === "object"
      ? (script.content as Record<string, unknown>)
      : { original: script.content };
  if (content.narration === text) return { synced: false, source };

  updateScriptContent(scriptId, {
    ...content,
    narration: text,
    narrationSyncedAt: new Date().toISOString(),
    narrationSyncedFrom: source,
  });
  return { synced: true, source, length: text.length };
}
