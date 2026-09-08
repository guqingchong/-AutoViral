/**
 * works 目录清理(改造项 S5,2026-09)。
 *
 * 背景:works 目录积累 42,386 个残留目录(13.7GB,test/批量失败留下)——不在 works 表
 * 有记录,纯垃圾占盘。本模块清"不在表 + 超 N 天无活动"的目录。
 *
 * 保守规则(2026-09 用户确认做,但删了不可恢复,故保守):
 * - 只清理"不在 works 表"的目录(有记录的绝不删)
 * - 默认 30 天无活动才删(防止清理正在创建中的目录)
 * - 手动触发(CLI autocode clean-works),不自动执行——避免误删不可恢复
 */

import { readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { getDb } from "../db/connection.js";

export interface CleanResult {
  deleted: number;
  kept: number;
}

export async function cleanWorksDirs(olderThanDays = 30, dryRun = false): Promise<CleanResult> {
  const db = getDb();
  const valid = new Set<string>(db.prepare("SELECT id FROM works").pluck().all() as string[]);
  const worksDir = join(dataDir, "works");
  let deleted = 0;
  let kept = 0;

  let entries: string[] = [];
  try {
    entries = await readdir(worksDir);
  } catch {
    // works 目录不存在 → 无可清理
    return { deleted, kept };
  }

  for (const name of entries) {
    const full = join(worksDir, name);
    // 有记录的目录绝不删
    if (valid.has(name)) { kept++; continue; }
    try {
      const st = await stat(full);
      if (!st.isDirectory()) { kept++; continue; }
      if (Date.now() - st.mtimeMs > olderThanDays * 86400e3) {
        if (!dryRun) await rm(full, { recursive: true, force: true });
        deleted++;
      } else {
        kept++; // 未超 30 天,保守保留(可能是正在创建的目录)
      }
    } catch {
      kept++; // stat 失败,保守保留
    }
  }
  return { deleted, kept };
}
