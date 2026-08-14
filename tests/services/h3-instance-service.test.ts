import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  getConfig: vi.fn(),
  H3_TUNNEL_DEFAULTS: { host: "h", port: 22, user: "root", localPort: 8188, remotePort: 8188 },
}));
vi.mock("../../src/services/h3-tunnel-service.js", () => ({
  ensureH3Tunnel: vi.fn(),
  rotateH3Tunnel: vi.fn(),
  resolveH3TunnelConfig: vi.fn(() => ({ host: "h", port: 22, user: "root", localPort: 8188, remotePort: 8188 })),
  stopH3Tunnel: vi.fn(),
}));

import * as configModule from "../../src/config.js";
import * as h3Tunnel from "../../src/services/h3-tunnel-service.js";
import {
  getH3InstanceView,
  recordH3Activity,
  assertH3Ready,
  stopH3HealthLoop,
  __resetForTests,
} from "../../src/services/h3-instance-service.js";

const cfg = {
  h3: { baseUrl: "http://localhost:8188", gpuHourlyRateYuan: 2.18, idleReminderMinutes: 30 },
} as any;

function stubFetch(ok: boolean) {
  const fetchMock = vi.fn().mockResolvedValue({ ok });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("h3-instance-service", () => {
  beforeEach(() => {
    __resetForTests();
    (configModule.getConfig as any).mockReturnValue(cfg);
    (h3Tunnel.ensureH3Tunnel as any).mockResolvedValue(false);
    (h3Tunnel.rotateH3Tunnel as any).mockResolvedValue(false);
  });
  afterEach(() => {
    stopH3HealthLoop();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ComfyUI 健康 → ready,带费率与控制台地址", async () => {
    stubFetch(true);
    const view = await getH3InstanceView();
    expect(view.state).toBe("ready");
    expect(view.gpuHourlyRateYuan).toBe(2.18);
    expect(view.idleReminderMinutes).toBe(30);
    expect(view.consoleUrl).toContain("autodl.com");
  });

  it("ComfyUI 不可达 → offline", async () => {
    stubFetch(false);
    const view = await getH3InstanceView();
    expect(view.state).toBe("offline");
  });

  it("隧道掉线自愈:首次探测失败,ensureH3Tunnel 重建后重试为 ready", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })   // 首次探测失败(隧道断了)
      .mockResolvedValueOnce({ ok: true });   // 隧道重建后重试成功
    vi.stubGlobal("fetch", fetchMock);
    (h3Tunnel.ensureH3Tunnel as any).mockResolvedValueOnce(true);

    const view = await getH3InstanceView();
    expect(view.state).toBe("ready");
    expect(h3Tunnel.ensureH3Tunnel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("假通 failover:隧道通但 ComfyUI 未响应 → rotate 切换候选实例后 ready", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })   // 首次探测失败
      .mockResolvedValueOnce({ ok: false })   // 隧道重建后仍失败(假通)
      .mockResolvedValueOnce({ ok: true });   // rotate 到候选实例后成功
    vi.stubGlobal("fetch", fetchMock);
    (h3Tunnel.ensureH3Tunnel as any).mockResolvedValueOnce(true);
    (h3Tunnel.rotateH3Tunnel as any).mockResolvedValueOnce(true);

    const view = await getH3InstanceView();
    expect(view.state).toBe("ready");
    expect(h3Tunnel.rotateH3Tunnel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("未配置 h3 段 → 始终 offline,不发请求", async () => {
    (configModule.getConfig as any).mockReturnValue({});
    const fetchMock = stubFetch(true);
    const view = await getH3InstanceView();
    expect(view.state).toBe("offline");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recordH3Activity 驱动空闲计时", async () => {
    stubFetch(true);
    recordH3Activity();
    const view = await getH3InstanceView();
    expect(view.lastActivityAt).not.toBeNull();
    expect(view.idleMinutes).toBe(0);
  });

  it("assertH3Ready 离线时抛出含 AutoDL 提示的错误", async () => {
    stubFetch(false);
    await expect(assertH3Ready()).rejects.toThrow("AutoDL");
  });
});
