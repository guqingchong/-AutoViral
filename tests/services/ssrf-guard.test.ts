import { describe, it, expect } from "vitest";
import { assertIpSafe, assertSafeUrl } from "../../src/services/web-search-service.js";

// C1 + 2026-09-08 复审 B1:SSRF 拦截矩阵(含 WHATWG URL hex 序列化绕过)
describe("SSRF assertIpSafe/assSafeUrl(C1)", () => {
  const blocked = [
    "127.0.0.1", "127.0.0.2", "127.255.255.254",       // 127/8 全段
    "::1", "::",                                          // 回环/未指定
    "169.254.169.254", "169.254.1.1",                     // 链路本地/元数据
    "100.64.0.1", "100.100.0.1", "100.127.255.254",       // CGNAT 100.64/10
    "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.0.1",
    "::ffff:127.0.0.1",                                   // v4-mapped 点分形
    "::ffff:7f00:1",                                      // v4-mapped hex 形(复审 B1)
    "0:0:0:0:0:ffff:a9fe:a9fe",                           // 全形 mapped(无法归一直接拦)
    "2130706433", "0x7f000001",                           // 数字字面量
  ];
  for (const h of blocked) {
    it(`拦截 ${h}`, () => {
      expect(() => assertIpSafe(h)).toThrow(/SSRF/);
    });
  }

  const allowed = ["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1", "1.1.1.1"];
  for (const h of allowed) {
    it(`放行 ${h}`, () => {
      expect(() => assertIpSafe(h)).not.toThrow();
    });
  }

  it("URL 层:[::ffff:127.0.0.1] 经 WHATWG 序列化后仍拦截", async () => {
    await expect(assertSafeUrl("http://[::ffff:127.0.0.1]/x")).rejects.toThrow(/SSRF/);
  });

  it("URL 层:127.0.0.2 / 169.254.1.1 拦截", async () => {
    await expect(assertSafeUrl("http://127.0.0.2/")).rejects.toThrow(/SSRF/);
    await expect(assertSafeUrl("http://169.254.1.1/")).rejects.toThrow(/SSRF/);
  });
});
