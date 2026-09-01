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
  it("keynote-leather 长口播 duration 上限 600s(2026-08-24)", () => {
    const ok = { workId: "w", filename: "f", duration: 300, template: { name: "keynote-leather", params: { title: "t" } } };
    expect(validateCodeSceneInput(ok as any)).toEqual([]);
    const tooLong = { ...ok, duration: 601 };
    expect(validateCodeSceneInput(tooLong as any).join()).toContain("1-600");
  });
  it("非法主题报错", () => {
    expect(validateCodeSceneInput({ ...base, theme: "neon" } as any).join()).toContain("theme");
  });
  it("structure-growth 分支数 2-4", () => {
    const bad = { workId: "w", filename: "f", template: { name: "structure-growth", params: { title: "t", center: "c", branches: [{ text: "a", label: "b" }] } } };
    expect(validateCodeSceneInput(bad as any).join()).toContain("2-4");
  });
  // 2026-08-24:keynote-leather 横屏整片模板接线
  it("keynote-leather 最小参数通过(title 主参数)", () => {
    const input = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "数字人新政解读" } } };
    expect(validateCodeSceneInput(input as any)).toEqual([]);
  });
  it("keynote-leather 标题上限 18 字(比竖屏模板宽)", () => {
    const ok = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "十四个字以内的标题没问题吧" } } };
    expect(validateCodeSceneInput(ok as any)).toEqual([]);
    const long = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "这是一个超过十八个字的横屏标题确实太长了点" } } };
    expect(validateCodeSceneInput(long as any).join()).toContain("≤18");
  });
  it("keynote-leather 字幕与比例参数校验", () => {
    const badCn = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "t", subtitleCn: "字".repeat(41) } } };
    expect(validateCodeSceneInput(badCn as any).join()).toContain("subtitleCn ≤40");
    const badRatio = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "t", videoRatio: -1 } } };
    expect(validateCodeSceneInput(badRatio as any).join()).toContain("videoRatio");
    const badSrc = { workId: "w", filename: "f", template: { name: "keynote-leather", params: { title: "t", videoSrc: 123 } } };
    expect(validateCodeSceneInput(badSrc as any).join()).toContain("videoSrc 须为字符串");
  });
  // 2026-09-01 05 方案 S3:web 支路服务层
  it("magazine_light 主题合法(05方案S2 新增)", () => {
    expect(validateCodeSceneInput({ ...base, theme: "magazine_light" } as any)).toEqual([]);
  });
  it("web 模板路由:big-number 命中 WEB_TEMPLATES", async () => {
    const { WEB_TEMPLATES } = await import("../../src/services/code-scene.js");
    expect(Object.keys(WEB_TEMPLATES)).toContain("big-number");
  });
  it("web 模板参数校验复用 schema(big-number value 必填)", () => {
    const bad = { workId: "w", filename: "f", template: { name: "big-number", params: { title: "t" } } };
    expect(validateCodeSceneInput(bad as any).join()).toContain("value");
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
    // 2026-08-19 根因修复回归:duration 必须生效——场景自然时长由模板内容决定
    // (flow-steps 3 步实测 3.8s),目标 4s 时产物须 ≥3.9s(末帧定格补齐),
    // 此前 >2 的断言太松放过了 bug
    expect(r.duration).toBeGreaterThanOrEqual(3.9);
  });

  // 2026-08-24:keynote-leather 接线验证——本地源片自动中转 public/staged + 横屏整片渲染
  const dhSample = "packages/code-scene/public/dh-sample.mp4";
  it.skipIf(!existsSync(dhSample))(
    "keynote-leather 本地数字人源片渲染(自动中转+比例探测+清理)",
    { timeout: 300_000 },
    async () => {
      const r = await renderCodeScene({
        workId: "w_code_scene_test",
        filename: "it-keynote",
        template: {
          name: "keynote-leather",
          params: {
            title: "数字人新政解读",
            kicker: "POLICY KEYNOTE",
            subtitleCn: "专项债新政,影响每一个城投人",
            subtitleEn: "New policy on special bonds",
            videoSrc: dhSample, // 本地路径:验证自动中转(而非已就绪的 /xxx.mp4 URL)
          },
        },
        duration: 5,
      });
      expect(r.error).toBeUndefined();
      expect(r.success).toBe(true);
      expect(r.path && existsSync(r.path)).toBe(true);
      // 横屏 1920×1080 默认尺寸
      const info = await probeMedia(r.path!);
      expect(info.width).toBe(1920);
      expect(info.height).toBe(1080);
      // 渲染结束后中转文件已清理(staged 目录不留 cs_* 残留)
      const { readdirSync } = await import("node:fs");
      const stagedDir = "packages/code-scene/public/staged";
      const leftovers = existsSync(stagedDir) ? readdirSync(stagedDir).filter((f) => f.startsWith("cs_")) : [];
      expect(leftovers).toEqual([]);
    },
  );
});

// 2026-08-24 kind="code" 集成:视频工厂整片路由端到端(种子模板→startRender→output 产物)
describe.skipIf(!workerReady)("video-factory code 模板端到端", () => {
  it("kind=code 模板经 startRender 渲染出横屏成片", { timeout: 420_000 }, async () => {
    const { resetInMemoryDb, closeDb } = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    const { ensureBuiltinCodeTemplates, KEYNOTE_LEATHER_TEMPLATE_ID } = await import("../../src/services/code-templates.js");
    const { createWork } = await import("../../src/db/works-repo.js");
    const { startRender, getRenderStatus } = await import("../../src/services/video-factory.js");
    const { resolve } = await import("node:path");

    // 样片 315s 会触发 30s 封顶渲染(太慢),先剪 12s 短源片
    const dir = await mkdtemp(join(tmpdir(), "av-code-tpl-"));
    const shortSrc = join(dir, "dh-short.mp4");
    const ffmpeg = await getFFmpegPath();
    await promisify(execFile)(ffmpeg, [
      "-ss", "30", "-t", "12", "-i", "packages/code-scene/public/dh-sample.mp4",
      "-c", "copy", "-y", shortSrc,
    ]);

    resetInMemoryDb();
    migrate();
    ensureBuiltinCodeTemplates();
    createWork({
      id: "w_code_tpl_e2e", title: "代码模板端到端验证", type: "short-video", status: "draft",
      platforms: ["douyin"], evaluation_mode: false, tags: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as never, []);

    const job = await startRender({
      workId: "w_code_tpl_e2e",
      templateId: KEYNOTE_LEATHER_TEMPLATE_ID,
      digitalHumanVideo: resolve(shortSrc),
      assets: {},
      variables: { subtitleCn: "端到端中文字幕", subtitleEn: "E2E ENGLISH SUB" },
    });

    const deadline = Date.now() + 360_000;
    let status = getRenderStatus(job.jobId);
    while (status && (status.status === "pending" || status.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      status = getRenderStatus(job.jobId);
    }
    expect(status?.error).toBeUndefined();
    expect(status?.status).toBe("completed");
    expect(existsSync(job.outputPath)).toBe(true);
    const info = await probeMedia(job.outputPath);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    // 数字人口播音轨随 revideo 导出(口播没声音=废片)
    expect(info.hasAudio).toBe(true);
    // 时长跟随源片(12s,末帧定格补齐)
    expect(info.duration).toBeGreaterThanOrEqual(11.5);
    closeDb();
    await rm(dir, { recursive: true, force: true });
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
