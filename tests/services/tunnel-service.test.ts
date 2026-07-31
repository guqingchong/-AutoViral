import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const createConnectionMock = vi.fn();
vi.mock("node:net", () => ({
  default: { createConnection: (...args: unknown[]) => createConnectionMock(...args) },
  createConnection: (...args: unknown[]) => createConnectionMock(...args),
}));

vi.mock("../../src/config.js", () => ({
  getConfig: vi.fn(() => ({
    heygem: {
      tunnel: { host: "connect.test.com", port: 28830, user: "root", localPort: 6006, remotePort: 6008 },
    },
  })),
  HEYGEM_TUNNEL_DEFAULTS: { host: "connect.test.com", port: 28830, user: "root", localPort: 6006, remotePort: 6008 },
}));

import { ensureTunnel, stopTunnel, isTunnelRunning, __resetForTests } from "../../src/services/tunnel-service.js";

/** 假 socket：异步发出 connect 或 error 事件 */
function fakeSocket(connectable: boolean) {
  const s = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  s.destroy = vi.fn();
  queueMicrotask(() => {
    if (connectable) s.emit("connect");
    else s.emit("error", new Error("ECONNREFUSED"));
  });
  return s;
}

/** 假子进程 */
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  c.exitCode = null;
  c.killed = false;
  c.kill = vi.fn(() => { c.killed = true; return true; });
  return c;
}

describe("tunnel-service", () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    __resetForTests();
    vi.clearAllMocks();
  });

  it("spawns ssh with forwarding args and returns true once port is connectable", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    // 首次（spawn 前的预检）不可连接，spawn 后可连接
    createConnectionMock
      .mockImplementationOnce(() => fakeSocket(false))
      .mockImplementation(() => fakeSocket(true));

    const ok = await ensureTunnel();
    expect(ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ssh");
    expect(args).toContain("-N");
    expect(args).toContain("-L");
    expect(args).toContain("6006:127.0.0.1:6008");
    expect(args).toContain("-p");
    expect(args).toContain("28830");
    expect(args).toContain("root@connect.test.com");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(opts.stdio).toBe("ignore");
    expect(opts.detached).toBe(false);

    expect(isTunnelRunning()).toBe(true);
  });

  it("ensureTunnel 成功后重复调用不重复 spawn", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    createConnectionMock
      .mockImplementationOnce(() => fakeSocket(false))
      .mockImplementation(() => fakeSocket(true));

    expect(await ensureTunnel()).toBe(true);
    expect(await ensureTunnel()).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("隧道进程 exit 后 isTunnelRunning 为 false，下次 ensureTunnel 会重建", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    createConnectionMock
      .mockImplementationOnce(() => fakeSocket(false))
      .mockImplementation(() => fakeSocket(true));

    expect(await ensureTunnel()).toBe(true);
    expect(isTunnelRunning()).toBe(true);

    child.exitCode = 1;
    child.emit("exit", 1);
    expect(isTunnelRunning()).toBe(false);

    // 重建：端口仍可用（模拟旧转发还在）→ 直接复用不 spawn；
    // 端口不可用 → 重新 spawn
    createConnectionMock.mockImplementation(() => fakeSocket(false));
    const child2 = fakeChild();
    spawnMock.mockReturnValue(child2);
    const p = ensureTunnel();
    // 让 waitForPort 第一次失败后成功
    createConnectionMock.mockImplementation(() => fakeSocket(true));
    expect(await p).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("本地端口已可连接（手动隧道）时不 spawn，直接返回 true", async () => {
    createConnectionMock.mockImplementation(() => fakeSocket(true));
    expect(await ensureTunnel()).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    // 复用的是外部隧道，本模块不视为"自己在跑"
    expect(isTunnelRunning()).toBe(false);
  });

  it("端口一直不可连接时返回 false 并杀掉子进程", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      createConnectionMock.mockImplementation(() => fakeSocket(false));

      const p = ensureTunnel();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await p).toBe(false);
      expect(child.kill).toHaveBeenCalled();
      expect(isTunnelRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopTunnel 终止本模块启动的隧道进程", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    createConnectionMock
      .mockImplementationOnce(() => fakeSocket(false))
      .mockImplementation(() => fakeSocket(true));

    expect(await ensureTunnel()).toBe(true);
    stopTunnel();
    expect(child.kill).toHaveBeenCalled();
    expect(isTunnelRunning()).toBe(false);
  });

  it("spawn 抛异常（ssh 不存在）时返回 false", async () => {
    createConnectionMock.mockImplementation(() => fakeSocket(false));
    spawnMock.mockImplementation(() => { throw new Error("spawn ssh ENOENT"); });
    expect(await ensureTunnel()).toBe(false);
    expect(isTunnelRunning()).toBe(false);
  });
});
