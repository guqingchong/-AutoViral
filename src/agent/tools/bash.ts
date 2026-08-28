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
          timeout: { type: "number", description: "超时毫秒数（默认 120000；传小于 1000 的值会被当作秒处理，如 600 = 600 秒）" },
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
      // 2026-08-28 批次3.2:外网抓站精确拦截(实证:4 作品 curl 抓站 509 次 vs $web_search 8 次,
      // 作品目录散落 20+ 抓站残片)。纪律:内部 API curl 占 70-90%(advance/stock-assets 等),
      // 严禁一刀切——只拦"含外网 URL"的 curl/wget;yt-dlp(独立二进制)不受影响。
      if (/\b(curl|wget)\b/i.test(command)) {
        const urls = command.match(/https?:\/\/[^\s"'`]+/gi) ?? [];
        const external = urls.filter(
          (u) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?]|$)/i.test(u),
        );
        if (external.length) {
          return (
            `拦截:禁止用 curl/wget 直连外网(${external[0].slice(0, 60)})。换路:` +
            `①联网搜索/调研 → 调用 $web_search 工具;②素材下载 → POST /api/stock-assets/download;` +
            `③全网视频下载 → yt-dlp;④内部 API → curl localhost:3271 不受影响。` +
            `外网抓取 HTML 页面的成功率极低且已被评审判定为无效路径,请改用上述通道。`
          );
        }
      }
      for (const rule of rules) {
        if (rule.test(command)) throw new Error(`Bash: 命令被安全策略拦截: ${command.slice(0, 80)}`);
      }
      // 单位容错(2026-08-26 实证):agent 习惯按秒传值(timeout:600 想要 10 分钟),
      // 按毫秒解释会在 0.6s 误杀长任务。小于 1000 的值一律按秒换算。
      let timeoutMs = Number(input.timeout) || 120_000;
      if (timeoutMs < 1000) timeoutMs *= 1000;
      const timeout = Math.min(timeoutMs, 600_000);
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
        };
        // 进程树杀(2026-08-26 死锁实证):Windows 下 p.kill 只杀直接子进程(bash 壳),
        // bash→py→python 的孙进程变孤儿继续跑,其继承的 stdout 管道不关,
        // Node 的 close 事件(等全部 stdio 关闭)永不触发 → 工具 Promise 永久挂起
        // → agent loop 整体冻结(whisper ASR 20 分钟静默事故)。taskkill /T 杀整棵树。
        const killTree = () => {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true }).unref();
          } else {
            try { process.kill(-p.pid!, "SIGKILL"); } catch { p.kill("SIGKILL"); }
          }
        };
        const killTimer = setTimeout(() => {
          p.kill("SIGTERM");
          setTimeout(killTree, 3000);
        }, timeout);
        p.stdout.on("data", pushOut);
        p.stderr.on("data", pushOut);
        // 批次4.1 心跳:每 12s 回传输出尾部(无新输出则报"执行中"),UI 不再对
        // ffmpeg/whisper 等长命令黑窗——静默时段曾是"分不清慢与死"的最大来源
        const heartbeat = setInterval(() => {
          const excerpt = (tail || head).slice(-300).trim();
          ctx.onProgress?.(excerpt ? `…${excerpt}` : "(命令执行中,暂无输出)");
        }, 12_000);
        ctx.signal?.addEventListener("abort", () => { p.kill("SIGTERM"); setTimeout(killTree, 2000); }, { once: true });
        // 双通道兜底:exit(进程退出)先到 → 给 5s 让 stdio 冲刷后强制收尾,
        // 不等 close(孤儿进程持管道时 close 永不到来)
        let settled = false;
        const finish = (code: number | null, note = "") => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearInterval(heartbeat);
          const truncated = head.length >= HALF || tail.length >= HALF;
          const out = truncated
            ? `${head}\n…[输出过大,中段截断(头尾各保留 512KB)]…\n${tail}`
            : head;
          const result = truncateMiddle(out.trim());
          resolvePromise(code === 0 ? result || "（无输出）" : `Exit code ${code}${note}\n${result}`);
        };
        p.on("close", (code) => finish(code));
        p.on("exit", (code) => setTimeout(() => finish(code, " (exit 先于 close 收尾:可能有孤儿进程持有输出管道)"), 5000));
        p.on("error", (err) => {
          clearTimeout(killTimer);
          clearInterval(heartbeat);
          settled = true;
          resolvePromise(`执行失败: ${err.message}`);
        });
      });
    },
  };
}
