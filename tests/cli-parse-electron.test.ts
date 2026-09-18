import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * 2026-09-12 回归:打包后服务器由 electron.exe 以 ELECTRON_RUN_AS_NODE
 * 模式拉起,process.versions.electron 存在,commander 自动检测会把
 * argv 误判为"打包 Electron 应用"格式(slice(1)),导致脚本路径
 * dist/index.js 被当成 unknown command,服务器静默启动失败。
 * cli.ts 已强制 parseAsync(process.argv, { from: "node" })。
 *
 * 此测试不需要真的 electron:给 node 子进程伪装 process.versions.electron
 * 即可复现同一解析路径。
 */
describe("cli argv 解析(electron-as-node 环境)", () => {
  const cli = join(__dirname, "..", "dist", "cli.js");

  function runWithFakeElectron(args: string[]) {
    const shim = [
      `process.versions.electron = "31.7.7";`,
      `process.argv = ${JSON.stringify(["AutoViral.exe", "D:/fake/dist/index.js", ...args])};`,
      `import(${JSON.stringify("./dist/cli.js")}).then(m => m.runCLI());`,
    ].join("");
    return spawnSync(process.execPath, ["-e", shim], {
      cwd: join(__dirname, ".."),
      encoding: "utf-8",
      timeout: 30000,
    });
  }

  it("脚本路径不会被误当成命令", () => {
    const r = runWithFakeElectron(["zz-not-a-cmd"]);
    const err = (r.stderr || "") + (r.stdout || "");
    // 修复前:error: unknown command 'D:/fake/dist/index.js'(脚本路径被当命令)
    expect(err).not.toContain("D:/fake/dist/index.js");
    // 修复后:真正的未知命令名出现在错误里
    expect(err).toContain("zz-not-a-cmd");
  });

  it("--version 正常输出版本号", () => {
    const r = runWithFakeElectron(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
