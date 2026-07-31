import { describe, it, expect, beforeEach, vi } from "vitest";
import * as configModule from "../../src/config.js";
import { getInstanceStatus, powerOnInstance, powerOffInstance } from "../../src/services/autodl-client.js";

function mockApi(jsonBody: unknown) {
  return { ok: true, json: async () => jsonBody, text: async () => JSON.stringify(jsonBody) } as any;
}

const baseConfig = {
  port: 3271, model: "sonnet",
  jimeng: { accessKey: "", secretKey: "" },
  research: { enabled: false, schedule: "", platforms: [] },
  autodl: { token: "dev-tok", instanceUuid: "uuid-1", publicBaseUrl: "https://u.autodl.com", gpuHourlyRateYuan: 2.18, idleShutdownMinutes: 15 },
} as any;

describe("autodl-client", () => {
  beforeEach(() => {
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(baseConfig);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("powerOn posts to power_on with start command", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockApi({ code: "Success", data: null, msg: "" }));
    await powerOnInstance();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.autodl.com/api/v1/dev/instance/pro/power_on");
    expect(init.headers.Authorization).toBe("dev-tok");
    const body = JSON.parse(init.body);
    expect(body.instance_uuid).toBe("uuid-1");
    expect(body.payload).toBe("gpu");
    expect(body.start_command).toContain("start_api.sh");
  });

  it("powerOff posts instance uuid", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockApi({ code: "Success", data: null, msg: "" }));
    await powerOffInstance();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.autodl.com/api/v1/dev/instance/pro/power_off");
  });

  it("throws API msg on non-Success code", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockApi({ code: "BalanceNotEnough", msg: "余额不足", data: null }));
    await expect(powerOnInstance()).rejects.toThrow("余额不足");
  });

  it("maps instance detail status", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockApi({ code: "Success", data: { status: "running" } }));
    expect(await getInstanceStatus()).toBe("running");
  });

  it("throws when token not configured", async () => {
    vi.spyOn(configModule, "loadConfig").mockResolvedValue({ ...baseConfig, autodl: undefined });
    await expect(powerOnInstance()).rejects.toThrow("AutoDL");
  });
});
