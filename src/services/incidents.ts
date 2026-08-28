/**
 * 事故/教训卡(2026-08-28 批次10.3,v3-M14 学习回路最小实现)。
 *
 * 作品失败(评审熔断等)时写事故卡;新作品会话启动时注入最近教训摘要——
 * 消灭"失败即换皮重跑、零教训传递"(05d→224 形态)。
 */

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";

const dir = () => join(dataDir, "incidents");

/** 写事故卡(作品级失败/熔断时调用) */
export async function recordIncident(workId: string, stage: string, summary: string): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(
      join(dir(), `${ts}_${workId}.md`),
      `# 事故卡:${workId}\n- 时间: ${new Date().toISOString()}\n- 阶段: ${stage}\n\n${summary}\n`,
      "utf-8",
    );
  } catch { /* 教训卡失败不阻断 */ }
}

/** 最近 N 张事故卡的摘要(会话启动注入用;空目录返回空串) */
export async function recentIncidentDigest(n = 3): Promise<string> {
  try {
    const files = (await readdir(dir())).filter((f) => f.endsWith(".md")).sort().slice(-n);
    if (!files.length) return "";
    const parts: string[] = [];
    for (const f of files) {
      const text = await readFile(join(dir(), f), "utf-8");
      parts.push(text.slice(0, 800));
    }
    return parts.join("\n\n---\n\n");
  } catch {
    return "";
  }
}
