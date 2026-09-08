import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// P2(2026-09-08 复审 M1):WS upgrade 鉴权判定矩阵——安全件必须有回归网
describe("ws-bridge authorizeUpgrade(P2)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-wsauth-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js").catch(() => ({ closeDb: () => {} }));
    closeDb?.();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  async function makeBridge(withToken: boolean) {
    if (withToken) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.yaml"), "port: 3271\nserver:\n  authToken: test-token-123\n", "utf-8");
    }
    const { loadConfig } = await import("../../src/config.js");
    await loadConfig();
    const { WsBridge } = await import("../../src/ws-bridge.js");
    const bridge = new WsBridge(3271);
    // 私有方法测试访问
    return (req: { url?: string; headers: Record<string, string> }) =>
      (bridge as unknown as { authorizeUpgrade: (r: unknown) => boolean }).authorizeUpgrade(req);
  }

  it("配置 token 后:正确 token 放行,错误/缺失拒绝", async () => {
    const auth = await makeBridge(true);
    expect(auth({ url: "/ws?token=test-token-123", headers: {} })).toBe(true);
    expect(auth({ url: "/ws?token=wrong", headers: {} })).toBe(false);
    expect(auth({ url: "/ws", headers: {} })).toBe(false);
    expect(auth({ url: "/ws/browser/w1?token=test-token-123", headers: {} })).toBe(true);
  });

  it("Origin 存在时仅放行本机回环源", async () => {
    const auth = await makeBridge(true);
    expect(auth({ url: "/ws?token=test-token-123", headers: { origin: "http://localhost:3271" } })).toBe(true);
    expect(auth({ url: "/ws?token=test-token-123", headers: { origin: "http://127.0.0.1:3271" } })).toBe(true);
    expect(auth({ url: "/ws?token=test-token-123", headers: { origin: "https://evil.example.com" } })).toBe(false);
    // Origin 非法 token 正确也拒(跨站 WS 不受同源限制,这是 P2 的攻击面)
    expect(auth({ url: "/ws?token=test-token-123", headers: { origin: "not-a-url" } })).toBe(false);
  });

  it("未配置 token:与 authGuard 同语义放行(但 Origin 白名单仍生效)", async () => {
    const auth = await makeBridge(false);
    expect(auth({ url: "/ws", headers: {} })).toBe(true);
    expect(auth({ url: "/ws", headers: { origin: "https://evil.example.com" } })).toBe(false);
  });
});
