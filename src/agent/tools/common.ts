/**
 * 路径安全与共享工具（2026-08-17 Phase 1）。
 * 文件工具的路径必须解析在允许根集合内——agent 拿到了完整文件读写能力，
 * 路径逃逸断言是唯一的边界（等价于 CLI 时代的权限收紧，见设计文档 §4.3）。
 */

import { resolve, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { dataDir } from "../../config.js";

/** 允许访问的根目录集合（每次调用时计算，dataDir 随配置变） */
export function allowedRoots(workDir: string): string[] {
  return [
    resolve(workDir),
    resolve(dataDir),
    resolve(join(homedir(), ".claude", "skills")),
    resolve(join(homedir(), ".autoviral")),
  ];
}

export class PathEscapeError extends Error {}

/**
 * 将用户输入路径解析为绝对路径并断言在允许根内。
 * 相对路径相对 workDir 解析；~ 展开到 homedir。
 */
export function assertPath(inputPath: string, workDir: string): string {
  let p = inputPath;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = join(homedir(), p.slice(1));
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(workDir, p);
  const roots = allowedRoots(workDir);
  if (!roots.some((root) => abs === root || abs.startsWith(root + "\\") || abs.startsWith(root + "/"))) {
    throw new PathEscapeError(`路径越界（允许范围：作品目录/数据目录/skills 目录）: ${inputPath}`);
  }
  return abs;
}

/** 截断：超 maxChars 保留头 headChars + 尾 tailChars */
export function truncateMiddle(text: string, maxChars = 30_000, headChars = 10_000, tailChars = 15_000): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return `${head}\n[...truncated ${text.length - headChars - tailChars} chars...]\n${tail}`;
}
