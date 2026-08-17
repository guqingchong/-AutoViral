/** Grep 工具：优先 spawn 系统 rg，缺失时 Node 递归扫描兜底 */

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolExecutor } from "./index.js";
import { assertPath, truncateMiddle } from "./common.js";

let rgPath: string | null | undefined;

async function findRg(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  const found: string | null = await new Promise((resolvePromise) => {
    const p = spawn("where", ["rg"], { shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      // 只认真实 .exe 二进制——npm shim（无扩展名的 cmd 包装）spawn 不起来
      const exe = out.trim().split("\n").map((s) => s.trim()).find((s) => s.toLowerCase().endsWith(".exe"));
      resolvePromise(code === 0 && exe ? exe : null);
    });
    p.on("error", () => resolvePromise(null));
  });
  rgPath = found;
  return rgPath;
}

async function nodeGrep(root: string, re: RegExp, maxResults: number): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) return;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const st = await stat(full).catch(() => null);
        if (!st || st.size > 1024 * 1024) continue;
        const text = await readFile(full, "utf-8").catch(() => null);
        if (!text || text.includes("\0")) continue;
        text.split("\n").forEach((line, i) => {
          if (results.length < maxResults && re.test(line)) {
            results.push(`${full}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    }
  }
  await walk(root);
  return results;
}

export const grepExecutor: ToolExecutor = {
  def: {
    name: "Grep",
    description: "在目录中按正则搜索文件内容，返回 文件:行号: 内容 列表（最多 100 条）。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索根目录（默认作品目录）" },
      },
      required: ["pattern"],
    },
  },
  async execute(input, ctx): Promise<string> {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new Error("Grep: pattern 必填");
    const root = input.path ? assertPath(String(input.path), ctx.workDir) : resolve(ctx.workDir);
    const rg = await findRg();
    if (rg) {
      return new Promise((resolvePromise, rejectPromise) => {
        const p = spawn(rg, ["--line-number", "--max-count", "100", "-e", pattern, root], { shell: false });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => {
          if (code === 0 || code === 1) resolvePromise(truncateMiddle(out.trim() || "（无匹配）"));
          else rejectPromise(new Error(`rg 失败: ${err.slice(0, 200)}`));
        });
        p.on("error", rejectPromise);
      });
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      throw new Error(`Grep: 正则无效: ${pattern}`);
    }
    const lines = await nodeGrep(root, re, 100);
    return lines.length ? lines.join("\n") : "（无匹配）";
  },
};
