import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/heygem-client.js", () => ({
  checkHealth: vi.fn(),
}));
vi.mock("../../src/services/tunnel-service.js", () => ({
  ensureTunnel: vi.fn(),
  rotateTunnel: vi.fn(),
}));
vi.mock("../../src/db/digital-human-jobs-repo.js", () => ({
  countActiveJobs: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
  getConfig: vi.fn(),
}));

import * as heygem from "../../src/services/heygem-client.js";
import * as tunnel from "../../src/services/tunnel-service.js";
import * as configModule from "../../src/config.js";
import {
  getInstanceView,
  recordActivity,
  assertReady,
  startHealthLoop,
  stopHealthLoop,
  __resetForTests,
} from "../../src/services/instance-service.js";

const cfg = {
  heygem: { apiToken: "t", baseUrl: "https://u", gpuHourlyRateYuan: 1.78, idleReminderMinutes: 15 },
} as any;

describe("instance-service (manual control)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTests();
    (configModule.loadConfig as any).mockResolvedValue(cfg);
    (configModule.getConfig as any).mockReturnValue(cfg);
    (tunnel.ensureTunnel as any).mockResolvedValue(false);
    (tunnel.rotateTunnel as any).mockResolvedValue(false);
  });
  afterEach(() => {
    stopHealthLoop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("healthy instance -> ready with config and consoleUrl", async () => {
    (heygem.checkHealth as any).mockResolvedValue(true);
    const view = await getInstanceView();
    expect(view.state).toBe("ready");
    expect(view.gpuHourlyRateYuan).toBe(1.78);
    expect(view.idleReminderMinutes).toBe(15);
    expect(view.consoleUrl).toContain("autodl.com");
    expect(view.lastActivityAt).toBeNull();
    expect(view.idleMinutes).toBe(0);
  });

  it("unhealthy instance -> offline", async () => {
    (heygem.checkHealth as any).mockResolvedValue(false);
    const view = await getInstanceView();
    expect(view.state).toBe("offline");
  });

  it("隧道掉线自愈：checkHealth 先失败，ensureTunnel 成功后重试为 ready", async () => {
    (heygem.checkHealth as any)
      .mockResolvedValueOnce(false)   // 首次探测失败（隧道断了）
      .mockResolvedValueOnce(true);   // 隧道重建后重试成功
    (tunnel.ensureTunnel as any).mockResolvedValueOnce(true);

    const view = await getInstanceView();
    expect(view.state).toBe("ready");
    expect(tunnel.ensureTunnel).toHaveBeenCalledTimes(1);
    expect(heygem.checkHealth).toHaveBeenCalledTimes(2);
  });

  it("隧道重建失败 → offline", async () => {
    (heygem.checkHealth as any).mockResolvedValue(false);
    (tunnel.ensureTunnel as any).mockResolvedValue(false);
    const view = await getInstanceView();
    expect(view.state).toBe("offline");
    // ensureTunnel 失败后不再重试 checkHealth
    expect(heygem.checkHealth).toHaveBeenCalledTimes(1);
  });

  it("未配置 heygem 时不尝试隧道自愈", async () => {
    (configModule.getConfig as any).mockReturnValue({ heygem: undefined });
    (heygem.checkHealth as any).mockResolvedValue(false);
    const view = await getInstanceView();
    expect(view.state).toBe("offline");
    expect(tunnel.ensureTunnel).not.toHaveBeenCalled();
  });

  it("assertReady throws when offline, passes when ready", async () => {
    (heygem.checkHealth as any).mockResolvedValue(false);
    await getInstanceView();
    await expect(assertReady()).rejects.toThrow("开机");

    (heygem.checkHealth as any).mockResolvedValue(true);
    await getInstanceView();
    await expect(assertReady()).resolves.toBeUndefined();
  });

  it("idleMinutes counts from lastActivity; 0 when no activity", async () => {
    (heygem.checkHealth as any).mockResolvedValue(true);
    const before = await getInstanceView();
    expect(before.idleMinutes).toBe(0);

    recordActivity();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 500);
    const after = await getInstanceView();
    expect(after.idleMinutes).toBe(10);
    expect(after.lastActivityAt).not.toBeNull();
  });

  it("recordActivity resets idle minutes to 0", async () => {
    (heygem.checkHealth as any).mockResolvedValue(true);
    recordActivity();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    recordActivity();
    const view = await getInstanceView();
    expect(view.idleMinutes).toBe(0);
  });

  it("startHealthLoop probes immediately and every 30 seconds", async () => {
    (heygem.checkHealth as any).mockResolvedValue(true);
    startHealthLoop();
    await vi.advanceTimersByTimeAsync(0);
    expect(heygem.checkHealth).toHaveBeenCalledTimes(1);
    const view = await getInstanceView();
    expect(view.state).toBe("ready");

    await vi.advanceTimersByTimeAsync(60_000);
    // 2 次循环探测 + getInstanceView 的实时探测
    expect((heygem.checkHealth as any).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("health loop drives state offline when instance goes down", async () => {
    (heygem.checkHealth as any).mockResolvedValue(true);
    startHealthLoop();
    await vi.advanceTimersByTimeAsync(0);
    (heygem.checkHealth as any).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(30_000);
    const view = await getInstanceView();
    expect(view.state).toBe("offline");
  });
});
