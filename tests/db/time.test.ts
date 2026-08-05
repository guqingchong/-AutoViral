import { describe, it, expect } from "vitest";
import { parseTsMs, latestTimestamp, toIsoUtc } from "../../src/db/time.js";

describe("db/time toIsoUtc（I6: 下发前归一化为 ISO 8601 带 Z）", () => {
  it("SQLite datetime('now') 空格格式 → ISO 带 Z", () => {
    expect(toIsoUtc("2026-08-05 10:00:00")).toBe("2026-08-05T10:00:00.000Z");
  });

  it("已是 ISO 带 Z → 保持不变（毫秒补齐）", () => {
    expect(toIsoUtc("2026-08-05T10:00:00.000Z")).toBe("2026-08-05T10:00:00.000Z");
    expect(toIsoUtc("2026-08-05T10:00:00Z")).toBe("2026-08-05T10:00:00.000Z");
  });

  it("无后缀 ISO 按 UTC 解释（不被当成本地时间）", () => {
    expect(toIsoUtc("2026-08-05T10:00:00")).toBe("2026-08-05T10:00:00.000Z");
  });

  it("空值与无法解析 → null", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(toIsoUtc("")).toBeNull();
    expect(toIsoUtc("not-a-date")).toBeNull();
  });

  it("latestTimestamp 取最新后不改动格式，toIsoUtc 负责归一化", () => {
    const latest = latestTimestamp(["2026-08-05T09:00:00.000Z", "2026-08-05 10:00:00"]);
    expect(latest).toBe("2026-08-05 10:00:00");
    expect(toIsoUtc(latest)).toBe("2026-08-05T10:00:00.000Z");
  });

  it("parseTsMs 与 toIsoUtc 对同一输入指向同一时刻", () => {
    const ms = parseTsMs("2026-08-05 10:00:00");
    expect(ms).not.toBeNull();
    expect(toIsoUtc("2026-08-05 10:00:00")).toBe(new Date(ms!).toISOString());
  });
});
