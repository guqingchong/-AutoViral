import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { renderCodeScene, validateCodeSceneInput } from "../../src/services/code-scene.js";

const base = { workId: "w_test", filename: "demo", template: { name: "flow-steps", params: { title: "三条标准", steps: [{ title: "隐债清零" }, { title: "剥离职能" }] } } };

describe("validateCodeSceneInput", () => {
  it("合法 flow-steps 输入通过", () => {
    expect(validateCodeSceneInput(base as any)).toEqual([]);
  });
  it("未知模板名报错", () => {
    const errs = validateCodeSceneInput({ ...base, template: { name: "hologram", params: {} } } as any);
    expect(errs.join()).toContain("未知场景模板");
  });
  it("template 与 customScene 二选一", () => {
    expect(validateCodeSceneInput({ workId: "w", filename: "f" } as any).join()).toContain("二选一");
    expect(validateCodeSceneInput({ ...base, customScene: "x" } as any).join()).toContain("二选一");
  });
  it("flow-steps 步数越界报错", () => {
    const tooMany = { ...base, template: { name: "flow-steps", params: { title: "t", steps: Array.from({ length: 6 }, (_, i) => ({ title: `s${i}` })) } } };
    expect(validateCodeSceneInput(tooMany as any).join()).toContain("2-5");
  });
  it("标题超长报错", () => {
    const long = { ...base, template: { name: "flow-steps", params: { title: "这是一个超过十二个字的超长标题啊", steps: [{ title: "a" }, { title: "b" }] } } };
    expect(validateCodeSceneInput(long as any).join()).toContain("≤12");
  });
  it("duration 超出 1-30 报错", () => {
    expect(validateCodeSceneInput({ ...base, duration: 60 } as any).join()).toContain("duration");
  });
  it("非法主题报错", () => {
    expect(validateCodeSceneInput({ ...base, theme: "neon" } as any).join()).toContain("theme");
  });
  it("structure-growth 分支数 2-4", () => {
    const bad = { workId: "w", filename: "f", template: { name: "structure-growth", params: { title: "t", center: "c", branches: [{ text: "a", label: "b" }] } } };
    expect(validateCodeSceneInput(bad as any).join()).toContain("2-4");
  });
});

// 集成测试:真实渲染(约 30-60s)。子项目未装依赖时跳过。
const workerReady = existsSync("packages/code-scene/node_modules");

describe.skipIf(!workerReady)("renderCodeScene 集成", () => {
  it("flow-steps 最小参数渲染出合法 mp4", { timeout: 240_000 }, async () => {
    const r = await renderCodeScene({
      workId: "w_code_scene_test",
      filename: "it-flow",
      template: { name: "flow-steps", params: { title: "退出三标准", steps: [{ title: "隐债清零" }, { title: "剥离职能" }, { title: "转型注销" }] } },
      duration: 4,
      theme: "finance_dark",
    });
    expect(r.success).toBe(true);
    expect(r.path && existsSync(r.path)).toBe(true);
    // 2026-08-19 根因修复回归:duration 必须生效——场景自然时长 ~2.07s,
    // 目标 4s 时产物须 ≥3.9s(末帧定格补齐),此前 >2 的断言太松放过了 bug
    expect(r.duration).toBeGreaterThanOrEqual(3.9);
  });
});

// 末帧定格补时(decidePadSeconds)纯逻辑
import { decidePadSeconds, padWithLastFrame } from "../../src/services/code-scene.js";
import { probeMedia, getFFmpegPath } from "../../src/video/ffmpeg.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("decidePadSeconds(末帧定格补时)", () => {
  it("自然时长不足 → 补差值", () => {
    expect(decidePadSeconds(2.07, 6)).toBeCloseTo(3.93, 2);
  });
  it("差距在容差内 → 不补(避免无谓重编码)", () => {
    expect(decidePadSeconds(5.9, 6)).toBe(0);
  });
  it("超出目标 → 不裁短(保住动画完整性)", () => {
    expect(decidePadSeconds(6.5, 6)).toBe(0);
  });
  it("无探测时长 → 不补", () => {
    expect(decidePadSeconds(undefined, 6)).toBe(0);
  });
});

// padWithLastFrame 真实 ffmpeg 集成(不依赖 Revideo/Edge,快速确定性)
describe("padWithLastFrame 集成", () => {
  it("2s 合成片段补 2s → 探测时长 ≈4s", { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "av-pad-"));
    const clip = join(dir, "clip.mp4");
    const ffmpeg = await getFFmpegPath();
    await promisify(execFile)(ffmpeg, [
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=30",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", "-y", clip,
    ]);
    const before = await probeMedia(clip);
    expect(before.duration).toBeGreaterThan(1.8);
    expect(before.duration).toBeLessThan(2.3);

    await padWithLastFrame(clip, 2.0);
    const after = await probeMedia(clip);
    expect(after.duration).toBeGreaterThanOrEqual(3.9);
    await rm(dir, { recursive: true, force: true });
  });
});
