import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertShotMapCompleteness } from "../../src/services/quality-gate.js";

// 2026-09-11(镜35/44 复盘):同一素材跨镜复用零拦截——两镜同源内容重复感,
// 且"取哪段"靠口头约定滋生规格矛盾(镜38 "3.0-8.3s 段"与 shot-map 8.6s 冲突同类)。
describe("assertShotMapCompleteness 素材复用检测", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-shotmap-"));
    mkdirSync(join(workDir, "assets"), { recursive: true });
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function writeShotMap(shots: unknown[]) {
    writeFileSync(join(workDir, "assets", "shot-map.json"), JSON.stringify({ shots }));
  }
  const base = (i: number, asset_file: string, extra: Record<string, unknown> = {}) =>
    ({ i, asset_file, frames: [`assets/frames/s${i}.jpg`], ...extra });

  it("每镜不同素材 → 通过", () => {
    writeShotMap([base(1, "clips/a.mp4"), base(2, "clips/b.mp4")]);
    expect(assertShotMapCompleteness(workDir)).toEqual([]);
  });

  it("同素材复用且无 segment 声明 → 拦(镜35/44 原型)", () => {
    writeShotMap([base(35, "clips/shot-43-underground.mp4"), base(44, "clips/shot-43-underground.mp4")]);
    const issues = assertShotMapCompleteness(workDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("shot_map_reuse_no_segment");
    expect(issues[0].detail).toContain("镜35/镜44");
  });

  it("复用但 segment 区间不重叠 → 通过", () => {
    writeShotMap([
      base(35, "clips/x.mp4", { segment: "0-4.5" }),
      base(44, "clips/x.mp4", { segment: "8.0-12.5" }),
    ]);
    expect(assertShotMapCompleteness(workDir)).toEqual([]);
  });

  it("复用且 segment 区间重叠 → 拦", () => {
    writeShotMap([
      base(35, "clips/x.mp4", { segment: "3.0-8.3" }),
      base(44, "clips/x.mp4", { segment: "6.0-10.0" }),
    ]);
    const issues = assertShotMapCompleteness(workDir);
    expect(issues.some((i) => i.key === "shot_map_reuse_overlap")).toBe(true);
  });

  it("segment 写法容错:'3.0-8.3s'/'3~8秒' 均可解析", () => {
    writeShotMap([
      base(1, "clips/x.mp4", { segment: "3.0-8.3s" }),
      base(2, "clips/x.mp4", { segment: "9~12秒" }),
    ]);
    expect(assertShotMapCompleteness(workDir)).toEqual([]);
  });
});
