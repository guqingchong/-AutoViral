import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("../../src/config.js", () => ({
  getConfig: vi.fn(),
  H3_TUNNEL_DEFAULTS: { host: "default-host", port: 22, user: "root", localPort: 8188, remotePort: 8188 },
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:net", () => ({
  default: { createConnection: vi.fn() },
}));

import { spawn } from "node:child_process";
import net from "node:net";
import * as configModule from "../../src/config.js";
import {
  ensureH3Tunnel,
  rotateH3Tunnel,
  resolveH3TunnelConfigs,
  __resetTunnelForTests,
} from "../../src/services/h3-tunnel-service.js";

const CANDIDATES = {
  h3: {
    tunnels: [
      { host: "host-a", port: 1111, user: "root", localPort: 8188, remotePort: 8188 },
      { host: "host-b", port: 2222, user: "root", localPort: 8188, remotePort: 8188 },
    ],
  },
} as any;

/** 造一个假 ssh 进程:常驻(exitCode=null),kill 后触发 exit */
function fakeProc() {
  const p = new EventEmitter() as any;
  p.exitCode = null;
  p.killed = false;
  p.kill = () => { p.killed = true; p.exitCode = 0; p.emit("exit"); };
  return p;
}

/** 控制本地端口可连性:每次 createConnection 评估一次 connectable,避免 once 注册时重复求值 */
function stubPort(connectable: () => boolean) {
  (net.createConnection as any).mockImplementation(() => {
    const ok = connectable();
    const s = new EventEmitter() as any;
    s.destroy = () => {};
    s.once = (event: string, cb: () => void) => {
      if (event === (ok ? "connect" : "error")) queueMicrotask(cb);
      return s;
    };
    return s;
  });
}

describe("h3-tunnel-service 多候选 failover", () => {
  beforeEach(() => {
    __resetTunnelForTests();
    (configModule.getConfig as any).mockReturnValue(CANDIDATES);
    (spawn as any).mockImplementation(() => fakeProc());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("resolveH3TunnelConfigs: tunnels 数组优先于单数 tunnel,并补默认值", () => {
    (configModule.getConfig as any).mockReturnValue({
      h3: { tunnel: { host: "single", port: 9999 }, tunnels: [{ host: "host-a", port: 1111 }] },
    });
    const list = resolveH3TunnelConfigs();
    expect(list).toHaveLength(1);
    expect(list[0].host).toBe("host-a");
    expect(list[0].localPort).toBe(8188); // 默认值补全
  });

  it("候选1 失败 → 自动尝试候选2 并成功,记住成功候选", async () => {
    // 端口前 15.5s 不可连(候选1 的 waitForPort 耗尽),之后可连(候选2)
    let elapsed = 0;
    vi.useFakeTimers();
    stubPort(() => elapsed > 15_500);

    const p = ensureH3Tunnel();
    // 推进候选1 的 30 次 × 500ms
    for (let i = 0; i < 31; i++) { elapsed += 500; await vi.advanceTimersByTimeAsync(500); }
    // 推进候选2
    for (let i = 0; i < 3; i++) { elapsed += 500; await vi.advanceTimersByTimeAsync(500); }

    await expect(p).resolves.toBe(true);
    // spawn 了两次:先 host-a 后 host-b
    expect(spawn).toHaveBeenCalledTimes(2);
    expect((spawn as any).mock.calls[0][1]).toContain("root@host-a");
    expect((spawn as any).mock.calls[1][1]).toContain("root@host-b");
  });

  it("隧道存活时 ensureH3Tunnel 直接复用,不重复 spawn", async () => {
    // 第一次端口检查(复用判断)失败 → 走 spawn;之后 waitForPort 第一次就成功,无 timer 参与
    let checks = 0;
    stubPort(() => checks++ > 0);
    await expect(ensureH3Tunnel()).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    await expect(ensureH3Tunnel()).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("rotateH3Tunnel: 单候选时直接返回 false", async () => {
    (configModule.getConfig as any).mockReturnValue({ h3: { tunnel: { host: "only", port: 1 } } });
    await expect(rotateH3Tunnel()).resolves.toBe(false);
  });

  it("rotateH3Tunnel: 杀当前隧道并切到下一个候选", async () => {
    // failNext=true 时下一次端口检查失败一次(模拟复用检查未命中),之后可连
    let failNext = true;
    stubPort(() => { if (failNext) { failNext = false; return false; } return true; });

    await ensureH3Tunnel();
    expect((spawn as any).mock.calls[0][1]).toContain("root@host-a");

    // rotate: stop 后旧隧道端口已释放 → 复用检查应再失败一次,然后 spawn host-b
    // (connectable 在 createConnection 时同步求值,必须先设 failNext 再调用)
    failNext = true;
    const r = rotateH3Tunnel();
    await expect(r).resolves.toBe(true);
    expect((spawn as any).mock.calls[1][1]).toContain("root@host-b");
  });
});
