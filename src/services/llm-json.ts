/**
 * Reusable LLM JSON prompt runner.
 * Uses the same spawn-based Claude CLI pattern as content-generator.ts.
 */

import { resolveClaudeCommand } from "../ws-bridge.js";
import { spawn } from "node:child_process";

export interface LlmJsonOptions {
  model?: string;
  timeoutMs?: number;
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

export async function runJsonPrompt<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
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
    });

    // Close stdin immediately to prevent 3s wait for stdin data
    try { proc.stdin?.end(); } catch { /* ignore */ }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("exit", (code) => {
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

    proc.on("error", reject);

    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("LLM JSON prompt timeout"));
    }, opts.timeoutMs ?? 180_000);
  });
}
