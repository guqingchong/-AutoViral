import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { type Publisher, type PublishInput, type PublishOutput } from "./types.js";
import { getCredential } from "../../db/platform-credentials-repo.js";

export interface YingdaoOptions {
  timeoutMs?: number;
}

/**
 * Escape a string for safe use as a cmd.exe argument.
 * Wraps in double quotes and escapes internal double quotes.
 */
function shellEscape(arg: string): string {
  if (!/[&|<>\^"%\s]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export abstract class YingdaoRPAPublisher implements Publisher {
  protected options: YingdaoOptions;

  constructor(options: YingdaoOptions = {}) {
    this.options = options;
  }

  abstract readonly platform: string;
  abstract readonly name: string;
  abstract readonly botFileName: string;

  isConfigured(): boolean {
    const botPath = getCredential(this.platform, "yingdao_bot_path");
    return !!botPath && existsSync(botPath);
  }

  async publish(input: PublishInput): Promise<PublishOutput> {
    const botPath = getCredential(this.platform, "yingdao_bot_path");
    if (!botPath) {
      return { success: false, error: `未配置 ${this.name} 影刀机器人路径` };
    }
    if (!existsSync(botPath)) {
      return { success: false, error: `影刀机器人文件不存在：${botPath}` };
    }
    const args = this.buildBotArgs(input);
    // Escape user-supplied arguments to prevent shell injection via cmd metacharacters
    const escaped = args.map(shellEscape);
    return this.runBot(botPath, escaped);
  }

  protected abstract buildBotArgs(input: PublishInput): string[];

  protected runBot(botPath: string, args: string[]): Promise<PublishOutput> {
    return new Promise((resolve) => {
      // On Windows, .bot files require cmd.exe for file association
      // Use explicit cmd.exe with escaped args — no { shell: true } implicit concatenation
      const proc: ChildProcess = process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/c", `"${botPath}"`, ...args], { shell: false })
        : spawn(botPath, args, { shell: false });
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: `影刀机器人执行超时 (${this.options.timeoutMs ?? 300000}ms)` });
      }, this.options.timeoutMs ?? 300000);
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          resolve({ success: false, error: stderr || `影刀机器人退出码 ${code}` });
          return;
        }
        try {
          const result = JSON.parse(stdout);
          resolve({
            success: result.success ?? true,
            platformPostId: result.platformPostId,
            postUrl: result.postUrl,
            error: result.error,
          });
        } catch {
          resolve({ success: true });
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      });
    });
  }
}
