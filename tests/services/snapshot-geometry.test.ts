import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHighlightBounds, checkContainFill, assertSnapshotGeometry } from "../../src/services/snapshot-geometry.js";

// 2026-09-11(assets 复盘改进点 4):红框坐标/遮罩覆盖机器预检——
// 评审第 2/3 轮烧 16 分钟 LLM 判的确定性几何,挡在 LLM 评审外。
describe("checkHighlightBounds 红框坐标包含", () => {
  it("界内坐标通过", () => {
    expect(checkHighlightBounds({ highlights: [{ left: 10, top: 20, width: 30, height: 15 }] })).toEqual([]);
  });
  it("右下角出界被拦", () => {
    const errs = checkHighlightBounds({ highlights: [{ left: 80, top: 20, width: 30, height: 15 }] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("出界");
  });
  it("左上角出界/非正宽高被拦", () => {
    expect(checkHighlightBounds({ highlights: [{ left: -2, top: 0, width: 10, height: 10 }] })).toHaveLength(1);
    expect(checkHighlightBounds({ highlights: [{ left: 0, top: 0, width: 0, height: 10 }] })).toHaveLength(1);
  });
});

describe("checkContainFill contain 占满率", () => {
  it("宽高比一致 → 占满率 1.0 通过", () => {
    const r = checkContainFill({ w: 3840, h: 1568 }, { w: 1832, h: 748 });
    expect(r.fill).toBeGreaterThan(0.99);
    expect(r.pass).toBe(true);
  });
  it("宽高比不一致 → 留白,判框坐标错位", () => {
    // 方形源图放进宽 wrap:左右留白,占满率 ~0.5
    const r = checkContainFill({ w: 1000, h: 1000 }, { w: 1832, h: 540 });
    expect(r.fill).toBeLessThan(0.96);
    expect(r.pass).toBe(false);
  });
});

describe("assertSnapshotGeometry 遮罩 alpha 覆盖(ffmpeg 实测)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "av-geo-"));
    mkdirSync(join(workDir, "assets", "overlays"), { recursive: true });
  });
  afterEach(() => rmSync(workDir, { recursive: true, force: true }));

  function writeSpecs(cards: unknown[]) {
    writeFileSync(join(workDir, "assets", "render-specs.json"), JSON.stringify({ cards }));
  }
  /** 右半 90% 不透明、左半全透的 100x100 遮罩 */
  function makeMask(name: string) {
    execFileSync("ffmpeg", ["-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=white@0.0:s=100x100,format=rgba",
      "-f", "lavfi", "-i", "color=c=white@0.9:s=50x100,format=rgba",
      "-filter_complex", "[0][1]overlay=x=50:y=0", "-frames:v", "1", join(workDir, "assets", "overlays", name)]);
  }

  it("镜38 原型:右半渐变不足 → 拦", () => {
    makeMask("m.png");
    // 全画面为 region:右半 alpha 0.9、左半 0 → coverage=0.5 < 0.6
    writeSpecs([{ shot: 38, file: "clips/shot-38.mp4", mask: { file: "assets/overlays/m.png", min_coverage: 0.6, min_max_alpha: 0.8 } }]);
    return assertSnapshotGeometry(workDir).then((issues) => {
      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe("mask_coverage_low");
    });
  });

  it("region 限定右半 → 遮罩达标通过", () => {
    makeMask("m.png");
    writeSpecs([{ shot: 38, file: "clips/shot-38.mp4", mask: { file: "assets/overlays/m.png", region: { left: 50, top: 0, width: 50, height: 100 }, min_coverage: 0.6, min_max_alpha: 0.8 } }]);
    return assertSnapshotGeometry(workDir).then((issues) => {
      expect(issues).toEqual([]);
    });
  });

  it("声明的遮罩文件不存在 → 拦", async () => {
    writeSpecs([{ shot: 38, file: "clips/shot-38.mp4", mask: { file: "assets/overlays/nope.png" } }]);
    const issues = await assertSnapshotGeometry(workDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("mask_missing");
  });

  it("无 render-specs.json → 跳过", async () => {
    expect(await assertSnapshotGeometry(workDir)).toEqual([]);
  });
});
