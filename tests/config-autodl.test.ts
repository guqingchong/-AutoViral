import { vi } from "vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config autodl/heygem", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-cfg-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(async () => {
    delete process.env.AUTOVIRAL_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips autodl and heygem config", async () => {
    const { loadConfig, saveConfig, getDefaultConfig } = await import("../src/config.js");
    const config = await loadConfig();
    config.autodl = {
      token: "tok", instanceUuid: "uuid-1",
      publicBaseUrl: "https://uuid-1.neimeng.autodl.com",
      gpuHourlyRateYuan: 2.18, idleShutdownMinutes: 15,
    };
    config.heygem = { apiToken: "secret" };
    await saveConfig(config);
    const reloaded = await loadConfig();
    expect(reloaded.autodl?.instanceUuid).toBe("uuid-1");
    expect(reloaded.autodl?.gpuHourlyRateYuan).toBe(2.18);
    expect(reloaded.heygem?.apiToken).toBe("secret");
  });

  it("default config has no chanjing/bailian fields", async () => {
    const { getDefaultConfig } = await import("../src/config.js");
    const d = getDefaultConfig() as Record<string, unknown>;
    expect(d.chanjing).toBeUndefined();
    expect(d.bailian).toBeUndefined();
  });
});
