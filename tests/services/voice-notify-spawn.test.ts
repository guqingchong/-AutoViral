import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _spawnPs } from "../../src/services/voice-notify.js";

// 2026-09-18 实测根因:speakNow 用 detached:true spawn PowerShell,
// 在本机(Node 25 / Windows 11)子进程拿到 PID 却从未执行脚本——
// 语音提醒自 2026-08-31 引入起从未响过的真正原因。
// 本测试用"写标记文件"代替真实发声,回归防护:子进程必须真实执行。

describe.runIf(process.platform === "win32")("_spawnPs 子进程真实执行(Windows)", () => {
  it("spawn 的 PowerShell 必须真实运行(写入标记文件)", async () => {
    const marker = join(tmpdir(), `av-spawn-${Date.now()}.txt`);
    try { unlinkSync(marker); } catch { /* 不存在则忽略 */ }
    _spawnPs(`[System.IO.File]::WriteAllText('${marker.replace(/\\/g, "\\\\")}', 'ok')`);

    const deadline = Date.now() + 20_000;
    let content: string | null = null;
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        content = readFileSync(marker, "utf-8");
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try { unlinkSync(marker); } catch { /* 清理失败无碍 */ }
    expect(content).toBe("ok");
  }, 25_000);
});
