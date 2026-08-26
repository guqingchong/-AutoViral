/**
 * Bash 工具（2026-08-17 Phase 1，Windows 关键件）。
 * 设计文档：docs/desigen/01 §4.3 / 实施方案 P1-T2
 *
 * - 优先 Git Bash（skills 里的命令全是 Unix 语法：管道/重定向/~ 展开）；
 *   探测顺序：常见安装路径 → where bash；结果缓存
 * - 默认 120s 超时（input.timeout 可覆写，单位毫秒）
 * - stdout+stderr 合并输出，超 30k 截头留尾
 * - bashBlocklist 正则黑名单（危险命令拦截）
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolContext, ToolExecutor } from "./index.js";
import { truncateMiddle } from "./common.js";

const DEFAULT_BLOCKLIST = ["rm\\s+-rf\\s+/", "format\\s+[a-z]:", "del\\s+/f\\s+/s\\s+/q"];

let bashPath: string | null | undefined;

function detectBash(): Promise<string | null> {
  if (bashPath !== undefined) return Promise.resolve(bashPath);
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      bashPath = c;
      return Promise.resolve(c);
    }
  }
  return new Promise((resolvePromise) => {
    const p = spawn("where", ["bash"], { shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const first = out.trim().split("\n")[0]?.trim();
      // 排除 WSL 的 System32 bash（语义不同）
      bashPath = code === 0 && first && !first.toLowerCase().includes("system32") ? first : null;
      resolvePromise(bashPath);
    });
    p.on("error", () => {
      bashPath = null;
      resolvePromise(null);
    });
  });
}

export function bashExecutor(blocklist?: string[]): ToolExecutor {
  const rules = (blocklist?.length ? blocklist : DEFAULT_BLOCKLIST).map((r) => new RegExp(r, "i"));
  return {
    def: {
      name: "Bash",
      description: "执行 shell 命令（Git Bash 语义，支持管道/重定向/ffmpeg/curl/python3）。默认 120 秒超时。",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          timeout: { type: "number", description: "超时毫秒数（默认 120000）" },
        },
        required: ["command"],
      },
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const command = String(input.command ?? "");
      if (!command) throw new Error("Bash: command 必填");
      // 空操作守卫(2026-08-26 kimi-for-coding 实测):模型上下文受损(会话恢复/配对修复)
      // 后会退化为反复输出 Bash(":") 这类 no-op 占位——空输出反过来加剧迷茫,形成
      // 死循环直到 LoopGuard 杀回合。直接在工具层拦截并给出可执行的纠偏提示。
      if (/^\s*(:|true|echo\s*)\s*$/.test(command)) {
        return "检测到空操作命令(无实际效果)。如果你不确定下一步,请回顾当前阶段指令;" +
          "如需推进流水线,执行 curl -X POST http://localhost:3271/api/works/<作品ID>/pipeline/advance " +
          "(body: {\"completedStep\":\"当前阶段\",\"nextStep\":\"下一阶段\"});如需联网搜索,调用 $web_search。禁止再用空命令占位。";
      }
      for (const rule of rules) {
        if (rule.test(command)) throw new Error(`Bash: 命令被安全策略拦截: ${command.slice(0, 80)}`);
      }
      const timeout = Math.min(Number(input.timeout) || 120_000, 600_000);
      const bash = await detectBash();
      const [cmd, args] = bash ? [bash, ["-lc", command]] : ["cmd", ["/c", command]];
      return new Promise((resolvePromise) => {
        const p = spawn(cmd, args, { cwd: ctx.workDir, windowsHide: true });
        // 有界缓冲(2026-08-18 崩溃根因):out += d 无上限,agent 误读二进制视频/大日志时
        // 字符串拼接撞 V8 最大串长(RangeError: Invalid string length)把整服务炸死。
        // 头 512KB 保底命令上下文 + 尾 512KB 滚动保留(错误信息通常在末尾)
        const HALF = 512 * 1024;
        let head = "";
        let tail = "";
        const pushOut = (d: Buffer | string) => {
          const s = typeof d === "string" ? d : d.toString("utf8");
          if (head.length < HALF) head += s.slice(0, HALF - head.length);
          tail = tail.length + s.length <= HALF ? tail + s : (tail + s).slice(-HALF);
        };        const killTimer = setTimeout(() => {
          p.kill("SIGTERM");
          setTimeout(() => p.kill("SIGKILL"), 3000);
        }, timeout);
        p.stdout.on("data", pushOut);
        p.stderr.on("data", pushOut);
        ctx.signal?.addEventListener("abort", () => p.kill("SIGTERM"), { once: true });
        p.on("close", (code) => {
          clearTimeout(killTimer);
          const truncated = head.length >= HALF || tail.length >= HALF;
          const out = truncated
            ? `${head}\n…[输出过大,中段截断(头尾各保留 512KB)]…\n${tail}`
            : head;
          const result = truncateMiddle(out.trim());
          resolvePromise(code === 0 ? result || "（无输出）" : `Exit code ${code}\n${result}`);
        });
        p.on("error", (err) => {
          clearTimeout(killTimer);
          resolvePromise(`执行失败: ${err.message}`);
        });
      });
    },
  };
}
