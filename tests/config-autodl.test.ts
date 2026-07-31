import { vi } from "vitest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config heygem", () => {
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

  it("round-trips heygem config", async () => {
    const { loadConfig, saveConfig } = await import("../src/config.js");
    const config = await loadConfig();
    config.heygem = {
      apiToken: "secret",
      baseUrl: "https://uuid-1.neimeng.autodl.com",
      gpuHourlyRateYuan: 1.78,
      idleReminderMinutes: 15,
    };
    await saveConfig(config);
    const reloaded = await loadConfig();
    expect(reloaded.heygem?.apiToken).toBe("secret");
    expect(reloaded.heygem?.baseUrl).toBe("https://uuid-1.neimeng.autodl.com");
    expect(reloaded.heygem?.gpuHourlyRateYuan).toBe(1.78);
    expect(reloaded.heygem?.idleReminderMinutes).toBe(15);
    expect((reloaded as Record<string, unknown>).autodl).toBeUndefined();
  });

  it("migrates legacy autodl config into heygem fields", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join: pjoin } = await import("node:path");
    await writeFile(
      pjoin(dir, "config.yaml"),
      [
        "autodl:",
        "  token: dev-tok",
        "  instanceUuid: uuid-1",
        "  publicBaseUrl: https://uuid-1.neimeng.autodl.com",
        "  gpuHourlyRateYuan: 2.18",
        "  idleShutdownMinutes: 20",
        "heygem:",
        "  apiToken: secret",
        "interests: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect((config as Record<string, unknown>).autodl).toBeUndefined();
    expect(config.heygem?.apiToken).toBe("secret");
    expect(config.heygem?.baseUrl).toBe("https://uuid-1.neimeng.autodl.com");
    expect(config.heygem?.gpuHourlyRateYuan).toBe(2.18);
    expect(config.heygem?.idleReminderMinutes).toBe(20);
  });

  it("default config has no chanjing/bailian fields", async () => {
    const { getDefaultConfig } = await import("../src/config.js");
    const d = getDefaultConfig() as Record<string, unknown>;
    expect(d.chanjing).toBeUndefined();
    expect(d.bailian).toBeUndefined();
  });

  it("loadConfig strips legacy chanjing/bailian keys from config.yaml", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join: pjoin } = await import("node:path");
    await writeFile(
      pjoin(dir, "config.yaml"),
      "chanjing:\n  appId: old\n  secretKey: old\nbailian:\n  apiKey: old\ninterests: []\n",
      "utf-8",
    );
    const { loadConfig } = await import("../src/config.js");
    const config = (await loadConfig()) as unknown as Record<string, unknown>;
    expect(config.chanjing).toBeUndefined();
    expect(config.bailian).toBeUndefined();
  });
});
