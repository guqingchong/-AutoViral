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

export async function runJsonPrompt<T>(prompt: string, opts: LlmJsonOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const cli = resolveClaudeCommand();
    const proc = spawn(cli, [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--model",
      opts.model ?? "sonnet",
    ], {
      cwd: process.env["HOME"] ?? process.cwd(),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
    });

    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    proc.on("exit", () => {
      try {
        const envelope = JSON.parse(stdout);
        const text = (envelope.result ?? "")
          .replace(/```json?\s*/gi, "")
          .replace(/```/g, "")
          .trim();
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        if (first < 0 || last <= first) {
          return reject(new Error("No JSON object in agent output"));
        }
        resolve(JSON.parse(text.slice(first, last + 1)) as T);
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);

    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("LLM JSON prompt timeout"));
    }, opts.timeoutMs ?? 180_000);
  });
}
