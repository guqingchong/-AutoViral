import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/autodl-client.js", () => ({
  getInstanceStatus: vi.fn(),
  powerOnInstance: vi.fn(),
  powerOffInstance: vi.fn(),
}));
vi.mock("../../src/services/heygem-client.js", () => ({
  checkHealth: vi.fn(),
}));
vi.mock("../../src/db/digital-human-jobs-repo.js", () => ({
  countActiveJobs: vi.fn(),
}));
vi.mock("../../src/config.js", () => ({
  loadConfig: vi.fn(),
  getConfig: vi.fn(),
}));

import * as autodl from "../../src/services/autodl-client.js";
import * as heygem from "../../src/services/heygem-client.js";
import * as jobsRepo from "../../src/db/digital-human-jobs-repo.js";
import * as configModule from "../../src/config.js";
import {
  getInstanceView,
  powerOn,
  powerOff,
  recordActivity,
  assertReady,
  startWatchdog,
  stopWatchdog,
  __resetForTests,
} from "../../src/services/instance-service.js";

const cfg = {
  autodl: { token: "t", instanceUuid: "u", publicBaseUrl: "https://u", gpuHourlyRateYuan: 2.18, idleShutdownMinutes: 15 },
} as any;

describe("instance-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTests();
    (configModule.loadConfig as any).mockResolvedValue(cfg);
    (configModule.getConfig as any).mockReturnValue(cfg);
    (jobsRepo.countActiveJobs as any).mockReturnValue(0);
  });
  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("powerOn success: calls autodl then polls health until ready", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(true);
    const view = await powerOn();
    expect(autodl.powerOnInstance).toHaveBeenCalledOnce();
    expect(view.state).toBe("ready");
  });

  it("powerOn failure: health never ok -> failed with error", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(false);
    const p = powerOn();
    await vi.advanceTimersByTimeAsync(310_000);
    const view = await p;
    expect(view.state).toBe("failed");
    expect(view.error).toContain("健康检查");
  }, 15000);

  it("powerOff rejected when jobs active", async () => {
    (jobsRepo.countActiveJobs as any).mockReturnValue(2);
    await expect(powerOff()).rejects.toThrow("任务");
    expect(autodl.powerOffInstance).not.toHaveBeenCalled();
  });

  it("powerOff failure: rolls back to ready, records error, rethrows", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(true);
    await powerOn();
    (autodl.powerOffInstance as any).mockRejectedValue(new Error("AutoDL API 错误"));
    await expect(powerOff()).rejects.toThrow("AutoDL API 错误");
    const view = await getInstanceView();
    expect(view.state).toBe("ready");
    expect(view.error).toContain("AutoDL API 错误");
  });

  it("watchdog auto powers off after idle timeout", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(true);
    await powerOn();
    startWatchdog();
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(autodl.powerOffInstance).toHaveBeenCalled();
  });

  it("watchdog does not power off with active jobs", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(true);
    (jobsRepo.countActiveJobs as any).mockReturnValue(1);
    await powerOn();
    startWatchdog();
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(autodl.powerOffInstance).not.toHaveBeenCalled();
  });

  it("assertReady throws when not ready", async () => {
    await expect(assertReady()).rejects.toThrow("开机");
  });

  it("getInstanceView reflects config and activity", async () => {
    (autodl.powerOnInstance as any).mockResolvedValue(undefined);
    (heygem.checkHealth as any).mockResolvedValue(true);
    const before = await getInstanceView();
    expect(before.state).toBe("stopped");
    expect(before.lastActivityAt).toBeNull();
    expect(before.gpuHourlyRateYuan).toBe(2.18);
    expect(before.idleShutdownMinutes).toBe(15);
    await powerOn();
    const after = await getInstanceView();
    expect(after.state).toBe("ready");
    expect(after.lastActivityAt).not.toBeNull();
  });

  it("recordActivity updates lastActivityAt", async () => {
    recordActivity();
    const view = await getInstanceView();
    expect(view.lastActivityAt).not.toBeNull();
  });
});
