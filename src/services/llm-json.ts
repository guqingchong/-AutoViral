/**
 * Reusable LLM JSON prompt runner.
 * Uses the same spawn-based Claude CLI pattern as content-generator.ts.
 */

import { resolveClaudeCommand } from "../ws-bridge.js";
import { spawn } from "node:child_process";

export interface LlmJsonOptions {
  model?: string;
  timeoutMs?: number;
  /** 最大尝试次数（含首次），默认 3。限流/超时/解析失败均会指数退避重试。 */
  maxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Try to extract a JSON object from arbitrary text.
 * Strips markdown fences, finds first { and last }, and parses.
 * Returns null if no valid JSON found.
 */
function extractJsonFromText(text: string): unknown | null {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * 带重试的 JSON 生成入口。
 * 背景（2026-07-21 Bug3）：批量创作并发 2 个 item 时，第二个 item 的
 * `claude -p` 进程因订阅并发限流以非零码退出且无 stdout，直接被判失败。
 * 这里对瞬态失败（非零退出、超时、JSON 提取失败）做指数退避重试，
 * 配合批量链路的串行队列（CONCURRENCY=1）消除限流。
 */
export async function runJsonPrompt<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffs = [5_000, 15_000, 30_000];
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runJsonPromptOnce<T>(prompt, opts);
    } catch (err) {
      lastError = err;
      // 永久性错误（如 CLI 不存在、spawn 失败）重试无意义，直接抛出
      if ((err as { noRetry?: boolean })?.noRetry) break;
      if (attempt < maxAttempts) {
        const wait = backoffs[attempt - 1] ?? 30_000;
        console.warn(
          `[llm-json] attempt ${attempt}/${maxAttempts} failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}; retrying in ${wait / 1000}s`,
        );
        await sleep(wait);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runJsonPromptOnce<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const cli = resolveClaudeCommand();
    // 关键约束：--allowedTools "" 禁用全部工具。
    // 否则 agentic CLI 会"热心地"把 JSON 结果写入文件（如 ~/xxx_templates.json）
    // 而不是输出到 stdout，导致 JSON 提取失败、生成任务报错。（2026-07-17 根因）
    const hardenedPrompt =
      prompt +
      "\n\n## 输出纪律（必须严格遵守）\n" +
      "- 直接把 JSON 作为你的回复文本输出，不要调用任何工具。\n" +
      "- 禁止创建、写入或保存任何文件；禁止执行命令。\n" +
      "- 不要使用 markdown 代码围栏，不要输出 JSON 以外的任何解释文字。\n";
    const proc = spawn(cli, [
      "-p",
      hardenedPrompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "",
      "--model",
      opts.model ?? "sonnet",
    ], {
      cwd: process.env["HOME"] ?? process.cwd(),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      windowsHide: true,
    });

    // Close stdin immediately to prevent 3s wait for stdin data
    try { proc.stdin?.end(); } catch { /* ignore */ }

    // 超时句柄：进程退出（成功或失败）时必须清理，避免 settle 后再次 reject/kill
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("LLM JSON prompt timeout"));
    }, opts.timeoutMs ?? 180_000);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      // If CLI exited with error and no stdout, reject immediately
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(
          "Claude CLI exited with code " + code + (stderr ? ": " + stderr.slice(0, 500) : "")
        ));
      }

      let text: string;

      // Step 1: Try parsing stdout as a JSON envelope (Claude --output-format json)
      try {
        const envelope = JSON.parse(stdout);
        text = (envelope.result ?? "").toString();
      } catch {
        // Step 2: stdout is not valid JSON envelope.
        // It might be raw model text output (if --output-format wasn't honored).
        // Try to extract a JSON envelope from the raw text first.
        const envelopeMatch = stdout.match(/\{[\s\S]*"result"[\s\S]*\}/);
        if (envelopeMatch) {
          try {
            const envelope = JSON.parse(envelopeMatch[0]);
            text = (envelope.result ?? "").toString();
          } catch {
            // Step 3: Treat entire stdout as model text
            text = stdout;
          }
        } else {
          // Step 3: Treat entire stdout as model text
          text = stdout;
        }
      }

      // Clean markdown fences from the extracted text
      text = text
        .replace(/```json\s*/gi, "")
        .replace(/```/g, "")
        .trim();

      // Step 4: Extract JSON object from the cleaned text
      const parsed = extractJsonFromText(text);
      if (parsed === null) {
        return reject(new Error(
          "No JSON object in LLM output. Preview: " + text.slice(0, 300)
        ));
      }
      resolve(parsed as T);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      // spawn 级错误（命令不存在/权限拒绝）属永久性故障，标记为不可重试
      (err as Error & { noRetry?: boolean }).noRetry = true;
      reject(err);
    });
  });
}
