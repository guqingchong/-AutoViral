/**
 * Bash 工具有界输出缓冲测试（2026-08-18 崩溃根因回归：
 * out += d 无上限 → RangeError: Invalid string length 炸死整个服务进程）。
 */
import { describe, it, expect } from "vitest";
import { bashExecutor } from "../../src/agent/tools/bash.js";

const ctx = { workDir: process.cwd(), signal: undefined } as any;

describe("bashExecutor 有界缓冲", () => {
  it("超大输出不炸进程,结果有界且保留头尾", async () => {
    const ex = bashExecutor([]);
    // 输出 ~5MB 文本(远超 1MB 上限)
    const result = await ex.execute(
      { command: "node -e \"for(let i=0;i<80000;i++) console.log('line-'+i+'-'+'x'.repeat(60))\"", timeout: 60_000 },
      ctx,
    );
    expect(result.length).toBeLessThan(1_200_000);
    expect(result).toContain("line-0"); // 头部保留
    expect(result).toContain("line-79999"); // 尾部保留
    expect(result).toContain("truncated"); // truncateMiddle 截断标记
  }, 90_000);

  it("正常小输出原样返回", async () => {
    const ex = bashExecutor([]);
    const result = await ex.execute({ command: "echo hello-bounded" }, ctx);
    expect(result.trim()).toBe("hello-bounded");
  }, 30_000);
});
