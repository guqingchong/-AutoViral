# code-scene 视觉升级(web 渲染支路)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 kind=web HTML 模板渲染支路(Playwright 确定性截帧)+ CSS design tokens 5 套主题 + 字幕胶囊安全区,标杆模板 big-number 出样片验收。

**Architecture:** 模板 = 自包含 HTML 页面(WAAPI 动画,参数经 window.__PARAMS__ 注入);web-worker.mjs 用 Playwright(channel=msedge,复用系统 Edge,不下载浏览器)逐帧 seek + 截图,ffmpeg 图片序列合成 mp4。服务层 code-scene.ts 加 WEB_TEMPLATES 注册表,名字命中即走 web 支路,复用并发池/门禁/资产登记。

**Tech Stack:** TypeScript(Node ESM)、Playwright 1.58(channel: msedge)、ffmpeg、vitest、Python 3(caption_generate.py)

**Spec:** `docs/desigen/05-code-scene视觉升级-web渲染支路.md`

## Global Constraints

- 字幕安全区(1080×1920 设计空间,中心原点):`SUBTITLE_ZONE = { yMin: 458, yMax: 602 }`,基线 y=530 = 屏幕第 1490 行,贴抖音底部 UI 遮挡区(y>1536)上沿;ass MarginV 底部**保持 430 不变**
- 渲染帧率固定 **30fps**;截帧用确定性时间驱动,**禁止实时录屏**
- 主题 key 集合:`finance_dark / warm_gold / ink_green / minimal_light / magazine_light`(新增)
- web 路由规则:模板名在 WEB_TEMPLATES 中 → 一律走 web 渲染器,不再查 Revideo 场景注册表
- Windows 环境:python 用 `py -3`;Edge 路径候选 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` 与 `C:/Program Files/Microsoft/Edge/Application/msedge.exe`
- 提交信息结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 字幕安全区常量(layout.ts)+ 三方一致性测试

**Files:**
- Modify: `packages/code-scene/src/layout.ts`
- Create: `tests/code-scene/safe-zone.test.ts`

**Interfaces:**
- Produces: `SUBTITLE_ZONE = { yMin: 458, yMax: 602 }`、`MARGIN = 96`、`CONTENT_TOP = -816`(均从 layout.ts 导出);Task 6 模板底部安全区(屏幕 y 1418-1562 带)依赖这组数值。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("字幕安全区三方一致性(2026-09-01 视觉升级)", () => {
  it("layout.ts 导出 SUBTITLE_ZONE 458-602 / MARGIN 96", () => {
    const src = readFileSync("packages/code-scene/src/layout.ts", "utf-8");
    expect(src).toContain("yMin: 458");
    expect(src).toContain("yMax: 602");
    expect(src).toContain("MARGIN = 96");
    expect(src).toContain("CONTENT_TOP = -816");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/code-scene/safe-zone.test.ts`
Expected: FAIL(no such file / 不包含 yMin)

- [ ] **Step 3: 实现 layout.ts 常量**

在 `packages/code-scene/src/layout.ts` 末尾追加:

```ts
/**
 * 字幕安全区(2026-09-01 视觉升级 05 方案 S1):
 * 设计空间中心原点,y ∈ [458, 602],基线 530 = 屏幕第 1490 行(ass MarginV=430,
 * 贴抖音底部 UI 遮挡区 y>1536 上沿——位置受平台 UI 约束,非纯审美选择)。
 * 所有模板内容禁止进入该区;字幕胶囊垂直中心落于此带。
 * 三方镜像:本文件(TS 模板侧)/ design-tokens.css(--safe-zone-h: 144px)/
 * caption_generate.py(margin_v=430)——tests/code-scene/safe-zone.test.ts 做一致性校验。
 */
export const SUBTITLE_ZONE = { yMin: 458, yMax: 602 } as const;
/** 左右边距 */
export const MARGIN = 96;
/** 内容区上限(顶部留白 144px) */
export const CONTENT_TOP = -816;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/code-scene/safe-zone.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-scene/src/layout.ts tests/code-scene/safe-zone.test.ts
git commit -m "feat(code-scene): 字幕安全区常量 SUBTITLE_ZONE(05方案S1)"
```

---

### Task 2: CSS design tokens 5 套主题

**Files:**
- Create: `packages/code-scene/src/design-tokens.css`
- Modify: `tests/code-scene/safe-zone.test.ts`(追加 tokens 一致性用例)

**Interfaces:**
- Consumes: Task 1 的 SUBTITLE_ZONE 数值(--safe-zone-h 必须是 144px)
- Produces: `design-tokens.css` 以 `:root[data-theme="<key>"] { ... }` 块定义 5 套主题;每套必须含变量 `--bg --bg-grid --accent --accent-2 --text --text-sub --shadow-lg --radius-card --ease-out --font-display --safe-zone-h`。Task 4 渲染器按主题 key 抽取对应块注入页面。

- [ ] **Step 1: 追加失败测试**

在 `tests/code-scene/safe-zone.test.ts` 的 describe 内追加:

```ts
  it("design-tokens.css 五套主题齐备且变量完整", () => {
    const css = readFileSync("packages/code-scene/src/design-tokens.css", "utf-8");
    const themes = ["finance_dark", "warm_gold", "ink_green", "minimal_light", "magazine_light"];
    const vars = ["--bg:", "--bg-grid:", "--accent:", "--accent-2:", "--text:", "--text-sub:",
      "--shadow-lg:", "--radius-card:", "--ease-out:", "--font-display:", "--safe-zone-h: 144px"];
    for (const t of themes) {
      expect(css, `缺主题 ${t}`).toContain(`[data-theme="${t}"]`);
    }
    for (const v of vars) {
      for (const t of themes) {
        const block = css.split(`[data-theme="${t}"]`)[1]?.split("}")[0] ?? "";
        expect(block, `主题 ${t} 缺变量 ${v}`).toContain(v);
      }
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/code-scene/safe-zone.test.ts`
Expected: FAIL(design-tokens.css 不存在)

- [ ] **Step 3: 写 design-tokens.css**

```css
/* 设计令牌系统(2026-09-01 视觉升级 05 方案 S2)
 * web 模板唯一视觉事实源:模板只引用变量,禁写死颜色/阴影/圆角。
 * 主题切换 = 渲染器注入对应 [data-theme] 块。
 * --safe-zone-h 与 layout.ts SUBTITLE_ZONE(864-720=144)一致,safe-zone.test.ts 校验。
 */

:root[data-theme="finance_dark"] {
  --bg: #0f1b2d;            --bg-grid: rgba(148, 163, 184, 0.05);
  --accent: #3b82f6;        --accent-2: #60a5fa;
  --text: #f1f5f9;          --text-sub: #94a3b8;
  --shadow-lg: 0 24px 64px rgba(2, 8, 23, 0.55);
  --radius-card: 24px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --font-display: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --safe-zone-h: 144px;
}

:root[data-theme="warm_gold"] {
  --bg: #161311;            --bg-grid: rgba(212, 175, 55, 0.05);
  --accent: #d4af37;        --accent-2: #e8c56b;
  --text: #f5efe0;          --text-sub: #a89968;
  --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.6);
  --radius-card: 24px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --font-display: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --safe-zone-h: 144px;
}

:root[data-theme="ink_green"] {
  --bg: #0d1f1a;            --bg-grid: rgba(63, 214, 143, 0.05);
  --accent: #3fd68f;        --accent-2: #2dd4bf;
  --text: #e8f5ee;          --text-sub: #8fbc9f;
  --shadow-lg: 0 24px 64px rgba(1, 12, 8, 0.55);
  --radius-card: 24px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --font-display: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --safe-zone-h: 144px;
}

:root[data-theme="minimal_light"] {
  --bg: #fafaf7;            --bg-grid: rgba(28, 25, 23, 0.05);
  --accent: #2563eb;        --accent-2: #60a5fa;
  --text: #1c1917;          --text-sub: #78716c;
  --shadow-lg: 0 24px 64px rgba(28, 25, 23, 0.12);
  --radius-card: 24px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --font-display: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --safe-zone-h: 144px;
}

/* 杂志编辑风(2026-09-01 新增):米白底 + 粗黑标题 + 点睛红 + 细分隔线 */
:root[data-theme="magazine_light"] {
  --bg: #fafaf7;            --bg-grid: rgba(28, 25, 23, 0.04);
  --accent: #dc2626;        --accent-2: #1c1917;
  --text: #1c1917;          --text-sub: #57534e;
  --shadow-lg: 0 24px 64px rgba(28, 25, 23, 0.10);
  --radius-card: 4px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --font-display: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --safe-zone-h: 144px;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/code-scene/safe-zone.test.ts`
Expected: PASS(2 个用例)

- [ ] **Step 5: Commit**

```bash
git add packages/code-scene/src/design-tokens.css tests/code-scene/safe-zone.test.ts
git commit -m "feat(code-scene): CSS design tokens 五套主题(含新增 magazine_light)(05方案S2)"
```

---

### Task 3: caption_generate.py 字幕胶囊样式(MarginV 保持 430)

**Files:**
- Modify: `skills/content-assembly/scripts/caption_generate.py`(PRESET_STYLES 55-150 行,style 构建段 ~490-510 行)
- Create: `skills/content-assembly/scripts/test_caption_safezone.py`(纯 assert 脚本,`py -3` 直跑)

**Interfaces:**
- Consumes: Task 1 的安全区数值(基线 y=530 中心原点 = MarginV 430,不改)
- Produces: ass Style 行 `BorderStyle=3`(半透明底盒胶囊)、BackColour `&H471E100A`(rgb(10,16,30) 72% 不透明,复用现有 `hex_to_ass_color(hex, alpha)` 第二参);`margin_v` 各预设**保持 430 不变**。

- [ ] **Step 1: 写失败测试**

```python
# skills/content-assembly/scripts/test_caption_safezone.py
# 运行: py -3 skills/content-assembly/scripts/test_caption_safezone.py
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import caption_generate as cg

config = cg.build_style_config("douyin-highlight", {})
lines = [[{"word": "测试字幕", "start": 0.0, "end": 1.0}]]
ass = cg.build_ass(lines, config)
style = next(l for l in ass.splitlines() if l.startswith("Style: Default,"))
fields = style.split(",")
# Format 序: Name(0) Fontname(1) Fontsize(2) Primary(3) Secondary(4) Outline(5)
#   Back(6) Bold(7) Italic(8) Underline(9) StrikeOut(10) ScaleX(11) ScaleY(12)
#   Spacing(13) Angle(14) BorderStyle(15) Outline(16) Shadow(17) Alignment(18)
#   MarginL(19) MarginR(20) MarginV(21) Encoding(22)
assert fields[15] == "3", f"BorderStyle 应为 3(胶囊底盒),实际 {fields[15]}"
assert "&H471E100A" in fields[6].upper(), f"BackColour 应为 &H471E100A,实际 {fields[6]}"
assert int(fields[16]) >= 12, f"胶囊 padding(Outline)应 ≥12,实际 {fields[16]}"
assert fields[21] == "430", f"MarginV 须保持 430(抖音 UI 遮挡区上沿),实际 {fields[21]}"
print("CAPTION SAFEZONE OK")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `py -3 skills/content-assembly/scripts/test_caption_safezone.py`
Expected: FAIL(BorderStyle 实际为 1)

- [ ] **Step 3: 实现**

`caption_generate.py` 修改:

1. 所有预设(PRESET_STYLES 各条目)新增 `"border_style": 3`;`margin_v` 一律不动(保持 430/600/1200 现值)。各预设 `back_color` 统一为 `"#0A101E"`(胶囊底色 rgb(10,16,30);原为 `"#80000000"` 类半透明黑,BorderStyle=3 下改深色)。

2. style_line 构建处(~499-510 行):
   - BorderStyle 字段:硬编码 `1` → `config.get("border_style", 1)`
   - BackColour:`hex_to_ass_color(config["back_color"])` → `hex_to_ass_color(config["back_color"], "47")`(0x47 ≈ 72% 不透明;该函数第二参 alpha 已存在,直接复用)
   - Outline 字段(padding):`config["outline_width"]` → `max(config["outline_width"], 12) if config.get("border_style") == 3 else config["outline_width"]`

- [ ] **Step 4: 跑测试确认通过**

Run: `py -3 skills/content-assembly/scripts/test_caption_safezone.py`
Expected: 输出 `CAPTION SAFEZONE OK`

- [ ] **Step 5: 回归冒烟(标点合并不被破坏)**

Run: `py -3 -c "import sys; sys.path.insert(0,'skills/content-assembly/scripts'); from caption_generate import group_words_into_lines; w=[{'word':'你好','start':0,'end':0.5},{'word':'。','start':1.2,'end':1.4}]; ls=group_words_into_lines(w); assert len(ls)==1 and len(ls[0])==2; print('MERGE OK')"`
Expected: `MERGE OK`

- [ ] **Step 6: Commit**

```bash
git add skills/content-assembly/scripts/caption_generate.py skills/content-assembly/scripts/test_caption_safezone.py
git commit -m "feat(caption): 字幕胶囊样式(BorderStyle=3 半透明底,MarginV 保持 430)(05方案S4)"
```

---

### Task 4: web-worker.mjs 确定性截帧渲染器

**Files:**
- Create: `packages/code-scene/web-worker.mjs`
- Create: `tests/code-scene/web-worker.test.ts`
- Create: `packages/code-scene/templates-web/_test-mock.html`(测试用最小模板)

**Interfaces:**
- Consumes: design-tokens.css(Task 2,按 `[data-theme="<key>"]` 抽取注入)
- Produces: CLI `node web-worker.mjs <spec.json>`;spec = `{ jobId, templatePath(绝对路径), params, theme, duration, width, height, outFile, outDir, ffmpegPath }`;产物 `outDir/outFile`(mp4)。页面契约:参数读 `window.__PARAMS__`,主题 CSS 文本读 `window.__THEME_CSS__`(均先于页面脚本注入);动画全部 WAAPI,渲染器按 `document.getAnimations()` 逐帧 seek;可选自定义钩子 `window.__seek(tSeconds)`(WAAPI 之外的状态同步,如计数文本)。

- [ ] **Step 1: 写测试模板 _test-mock.html**

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:#0f1b2d}
  #box{width:200px;height:200px;background:var(--accent,#3b82f6);position:absolute;left:440px;top:860px}
</style></head><body>
<div id="box"></div>
<div id="label" style="position:absolute;left:40px;top:100px;color:#fff;font-size:60px"></div>
<script>
  const style = document.createElement("style");
  style.textContent = window.__THEME_CSS__ || "";
  document.head.appendChild(style);
  document.getElementById("label").textContent = (window.__PARAMS__ || {}).title || "no-params";
  // WAAPI 动画:0→1s 从左移入
  document.getElementById("box").animate(
    [{ transform: "translateX(-300px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }],
    { duration: 1000, fill: "both", easing: "ease-out" }
  );
  // 自定义 seek 钩子:帧号显示
  window.__seek = (t) => { document.getElementById("label").dataset.t = t.toFixed(3); };
</script></body></html>
```

- [ ] **Step 2: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 集成测试:真实跑 web-worker 渲 1s mock 页。无 Edge 时跳过。
const edgeExists = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].some(existsSync);

describe.skipIf(!edgeExists)("web-worker 确定性截帧", () => {
  it("1s mock 页渲出 30 帧并合成 mp4", { timeout: 120_000 }, async () => {
    const outDir = mkdtempSync(join(tmpdir(), "web-worker-"));
    const spec = {
      jobId: "test01",
      templatePath: join(process.cwd(), "packages/code-scene/templates-web/_test-mock.html"),
      params: { title: "参数注入验证" },
      theme: "finance_dark",
      duration: 1, width: 1080, height: 1920,
      outFile: "mock.mp4", outDir,
      ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
    };
    const specPath = join(outDir, "spec.json");
    writeFileSync(specPath, JSON.stringify(spec));
    const r = spawnSync("node", ["packages/code-scene/web-worker.mjs", specPath], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(outDir, "mock.mp4"))).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/code-scene/web-worker.test.ts`
Expected: FAIL(web-worker.mjs 不存在)

- [ ] **Step 4: 实现 web-worker.mjs**

```js
// web-worker.mjs — kind=web HTML 模板确定性截帧渲染器(2026-09-01 05 方案 S3)
// 用法: node web-worker.mjs <spec.json>
// 确定性:逐帧 document.getAnimations() seek + screenshot,禁止实时录屏。
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

process.env.LANG = process.env.LANG || "zh_CN.UTF-8";

const specPath = process.argv[2];
if (!specPath) { console.error("usage: node web-worker.mjs <spec.json>"); process.exit(2); }
const spec = JSON.parse(await readFile(specPath, "utf-8"));

const FPS = 30;
const duration = Math.min(Math.max(spec.duration ?? 6, 1), 600);
const W = spec.width ?? 1080, H = spec.height ?? 1920;
const totalFrames = Math.round(duration * FPS);

// design-tokens.css 按主题抽块注入
const tokensPath = join(dirname(fileURLToPath(import.meta.url)), "src", "design-tokens.css");
const tokensCss = await readFile(tokensPath, "utf-8");
const themeKey = spec.theme ?? "finance_dark";
const m = tokensCss.match(new RegExp(`:root\\[data-theme="${themeKey}"\\]\\s*\\{([^}]*)\\}`));
if (!m) { console.error(JSON.stringify({ ok: false, error: `未知主题: ${themeKey}` })); process.exit(1); }
const themeCss = `:root{${m[1]}}`;

const { chromium } = await import("playwright");
const framesDir = join(spec.outDir, `${spec.jobId}_frames`);
await mkdir(framesDir, { recursive: true });
await mkdir(spec.outDir, { recursive: true });

const edgeCandidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const executablePath = edgeCandidates.find(existsSync);
const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  // 参数与主题先于页面脚本注入
  await page.addInitScript((params, css) => {
    window.__PARAMS__ = params;
    window.__THEME_CSS__ = css;
  }, spec.params ?? {}, themeCss);
  await page.goto("file:///" + spec.templatePath.replaceAll("\\", "/"));
  await page.evaluate(() => document.fonts.ready);

  for (let f = 0; f < totalFrames; f++) {
    const tMs = (f / FPS) * 1000;
    await page.evaluate((t) => {
      document.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = t; });
      window.__seek?.(t / 1000);
    }, tMs);
    await page.screenshot({ path: join(framesDir, `f${String(f).padStart(5, "0")}.png`), type: "png" });
  }
} finally {
  await browser.close();
}

// 图片序列 → mp4(与主仓渲染参数一致:libx264 crf18 yuv420p)
const ff = spec.ffmpegPath ?? "ffmpeg";
const out = join(spec.outDir, spec.outFile);
const enc = spawnSync(ff, [
  "-framerate", String(FPS), "-i", join(framesDir, "f%05d.png"),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-y", out,
], { encoding: "utf-8" });
await rm(framesDir, { recursive: true, force: true });
if (enc.status !== 0 || !existsSync(out)) {
  console.error(JSON.stringify({ ok: false, error: `ffmpeg 失败: ${enc.stderr?.slice(-400)}` }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, out, duration }));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/code-scene/web-worker.test.ts`
Expected: PASS(mock.mp4 产出)

- [ ] **Step 6: Commit**

```bash
git add packages/code-scene/web-worker.mjs packages/code-scene/templates-web/_test-mock.html tests/code-scene/web-worker.test.ts
git commit -m "feat(code-scene): web-worker 确定性截帧渲染器(WAAPI seek + Playwright msedge)(05方案S3)"
```

---

### Task 5: code-scene.ts 服务层 web 分支

**Files:**
- Modify: `src/services/code-scene.ts`(VALID_THEMES:21、TEMPLATE_LIMITS 区:48-62、validateCodeSceneInput、doRender:204+)
- Modify: `tests/services/code-scene.test.ts`

**Interfaces:**
- Consumes: Task 4 的 web-worker.mjs CLI 与 spec 结构
- Produces: `WEB_TEMPLATES: Record<string, { items?: string; min?: number; max?: number }>`(导出);路由规则——模板名在 WEB_TEMPLATES 中则 doRender 走 web-worker;`validateCodeSceneInput` 对 web 模板套用同名 schema 校验;VALID_THEMES 加 `magazine_light`。

- [ ] **Step 1: 追加失败测试**

在 `tests/services/code-scene.test.ts` 的 validate describe 内追加:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/services/code-scene.test.ts`
Expected: FAIL(magazine_light 非法 / WEB_TEMPLATES 未导出)

- [ ] **Step 3: 实现服务层分支**

`src/services/code-scene.ts` 修改:

```ts
// 21 行附近
const VALID_THEMES = new Set(["finance_dark", "warm_gold", "ink_green", "minimal_light", "magazine_light"]);

// TEMPLATE_LIMITS 之后新增:
/** kind=web HTML 模板注册表(2026-09-01 05 方案 S3):
 *  名字命中此处 → doRender 走 web-worker.mjs(Playwright 截帧),不再查 Revideo 场景表。
 *  schema 语义与 TEMPLATE_LIMITS 相同,校验复用同一套规则。 */
export const WEB_TEMPLATES: Record<string, { items?: string; min?: number; max?: number }> = {
  "big-number": {},
};
```

`validateCodeSceneInput` 中 `const limit = TEMPLATE_LIMITS[t.name];` 改为 `const limit = WEB_TEMPLATES[t.name] ?? TEMPLATE_LIMITS[t.name];`（其余校验逻辑不变,big-number value 必填规则已存在）。

`doRender` 中 runWorkerWithRetry 调用处改为按支路选择 worker:

```ts
    const isWeb = !!input.template && input.template.name in WEB_TEMPLATES;
    if (isWeb) {
      // web 支路 spec 增补:templatePath / theme / ffmpegPath
      const { getFFmpegPath } = await import("../video/ffmpeg.js");
      Object.assign(spec, {
        templatePath: join(WORKER_DIR, "templates-web", `${input.template!.name}.html`),
        theme: input.theme ?? (input.template!.params.theme as string | undefined) ?? "finance_dark",
        ffmpegPath: await getFFmpegPath(),
      });
      await writeFile(specPath, JSON.stringify(spec), "utf-8"); // 重写增补后的 spec
    }
    await rm(outputPath, { force: true });
    await runWorkerWithRetry(specPath, renderTimeoutMs(targetDuration), isWeb ? "web-worker.mjs" : "worker.mjs");
```

`runWorkerWithRetry` / `runWorker` 签名加第三参 `workerFile = "worker.mjs"`,spawn 行用 `spawn("node", [workerFile, specPath], ...)`。

注意:web 支路产物时长恒等于 targetDuration(截帧帧数即目标),不需要 `decidePadSeconds` 补时——doRender 中 pad 逻辑加 `if (!isWeb && pad > 0)` 守卫。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/services/code-scene.test.ts tests/code-scene/`
Expected: 全 PASS

- [ ] **Step 5: tsc + Commit**

Run: `npx tsc --noEmit`
```bash
git add src/services/code-scene.ts tests/services/code-scene.test.ts
git commit -m "feat(code-scene): 服务层 web 支路——WEB_TEMPLATES 注册表+路由+magazine_light 主题(05方案S3)"
```

---

### Task 6: 标杆模板 big-number.html + 样片验收

**Files:**
- Create: `packages/code-scene/templates-web/big-number.html`
- Modify: `tests/code-scene/web-worker.test.ts`(追加 big-number 真渲染冒烟)

**Interfaces:**
- Consumes: `window.__PARAMS__`(`{ title, kicker?, value, format?, unit?, caption?, source? }`,语义同 Revideo 版 BigNumberParams)、`window.__THEME_CSS__`、design tokens 变量、SUBTITLE_ZONE(底部 144px 禁内容)
- Produces: 按方向 A mockup 的 big-number 镜头;所有动画 WAAPI(fill:both),计数文本经 `window.__seek(t)` 钩子驱动;总动画时序 ≤ duration

- [ ] **Step 1: 写 big-number.html**

版式按 2026-09-01 浏览器 mockup(方向 A)逐元素落地:
- 网格底(用 `--bg-grid` 的 CSS background-image 线性渐变网格,非 DOM 线条)
- 左上 kicker chip 胶囊(border 1px accent 40% 透明、圆角 999px、字距 3px)
- 日期副行 + 主标题(字重 600/700 两级)
- 渐变巨字:`background: linear-gradient(135deg, var(--accent-2), var(--accent)); -webkit-background-clip: text`,字号 230px/900,单位 30%
- 数字下方渐变基线(width 动画)
- caption 解读行(text-sub,行高 1.7)
- 右上 L 形角标(accent 50% 透明)
- 底部来源标注必须避开安全区:屏幕 y 不得落入 1418-1562(中心原点 y∈[458,602]),置于其下方(如距底 60px 处)

动画契约(全部 WAAPI,duration 按 __PARAMS__.duration ?? 6 自适应):
- 短镜头(≤4.5s):0.25s 标题淡入 → 0.25s 数字淡入 → 0.7s 基线展开,计数经 __seek 从 60% 起滚
- 长镜头:0.5s 标题 → 0.6s 数字弹簧入场(scale keyframes 近似) → 1.4s 基线+计数 → 0.4s 脉冲
- 计数:__seek(t) 内按进度算当前值并格式化(plain/percent/wan/yi 规则从 Revideo 版 fmt 原样移植)

- [ ] **Step 2: 追加真渲染冒烟测试**

```ts
  it("big-number web 模板真渲染出片", { timeout: 180_000 }, async () => {
    const { renderCodeScene } = await import("../../src/services/code-scene.js");
    const r = await renderCodeScene({
      workId: "w_web_bignumber_test", filename: "bignumber-web",
      template: { name: "big-number", params: { title: "新能源装机投资", kicker: "行业数据", value: 5.4, format: "wan", caption: "同比增长 38%,首次超越火电", source: "国家能源局" } },
      theme: "finance_dark", duration: 6,
    } as any);
    expect(r.success, r.error).toBe(true);
    expect(r.duration).toBeGreaterThanOrEqual(5.9);
  });
```

放到 `describe.skipIf(!edgeExists)` 块内。

- [ ] **Step 3: 跑渲染出样片**

Run: `npx vitest run tests/code-scene/web-worker.test.ts -t "big-number"`
Expected: PASS;样片位于 `data/works/w_web_bignumber_test/assets/clips/code/bignumber-web.mp4`

- [ ] **Step 4: 样片送用户盲测**

把样片路径发给用户,等验收结论。**用户点头前不 commit 模板推广、不动其余 9 个 Revideo 模板。**

- [ ] **Step 5: Commit**

```bash
git add packages/code-scene/templates-web/big-number.html tests/code-scene/web-worker.test.ts
git commit -m "feat(code-scene): big-number web 标杆模板(方向A深色数据科技)(05方案S3)"
```

---

## 验收门槛( Spec §S5 )

- [ ] big-number HTML 版样片用户盲测通过
- [ ] `npx vitest run tests/code-scene tests/services/code-scene.test.ts` 全绿
- [ ] `py -3 skills/content-assembly/scripts/test_caption_safezone.py` 输出 OK
- [ ] `npx tsc --noEmit` 干净
- 其余 9 模板迁移、designTokens 注入评审契约等**不在本计划**(另立批次)
