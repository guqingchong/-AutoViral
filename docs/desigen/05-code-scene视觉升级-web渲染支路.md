# 05-code-scene 视觉升级:kind=web HTML 渲染支路 + 设计令牌系统

> 2026-09-01。回应 8-31 实测审查:程序化素材观感单调(渲染了但被弃用/观感 low)。
>  brainstorming 已定方向:设计方向 A(深色数据科技)、4 套色板全部深化 + 新增亮色杂志风、
>  字幕方案二(浮动胶囊 + 模板声明式 safeZone 元数据)、实施路径 B(HTML 渲染支路)。

## 一、问题与决策

### 病根
Revideo 代码画布没有真正的 CSS 布局引擎:无 box-shadow/backdrop-filter/渐变网格/
玻璃拟态,"精致网页效果"在该栈内不可达。字重常量阶梯治不了精致感。

### 决策
新增 `kind=web` 模板支路:模板 = 自包含 HTML 页面(内联 CSS/JS),Playwright
chromium 确定性截帧渲染出片。现有 Revideo 模板全部保留不动,新模板与标杆重做走
HTML 支路。Playwright 1.58 已是主仓依赖(RPA 发布器在用),零新增浏览器依赖。

### 范围(本批次)
1. 字幕安全区常量(所有渲染栈统一)
2. CSS design tokens 系统(5 套主题)
3. web 渲染器(web-worker.mjs)+ 服务层分支
4. 标杆模板 big-number HTML 重写 + 样片盲测
5. 字幕胶囊样式(caption_generate.py)
6. 其余 9 个 Revideo 模板迁移**不在本批次**(标杆验收通过后另立批次)

## 二、设计

### S1 字幕安全区(layout 层)
- 常量:`SUBTITLE_ZONE = { yMin: 720, yMax: 864 }`(1080×1920 设计空间,
  距底 96~240px 的 144px 高带);`MARGIN = 96`;`CONTENT_TOP = -816`
- 约束:所有模板内容禁止进入 SUBTITLE_ZONE;常量同时供机器门禁与合成层引用
- web 模板侧以 design token(`--safe-zone-h: 144px`)表达同一约定

### S2 CSS design tokens
- 新文件 `packages/code-scene/src/design-tokens.css`
- 变量组(每套主题):`--bg --bg-grid --accent --accent-2 --text --text-sub
  --shadow-lg --radius-card --ease-spring --ease-out --font-display`
- 5 套主题:
  | key | 基调 | 备注 |
  |---|---|---|
  | finance_dark | 深蓝 #0f1b2d + 蓝 #3b82f6 | 深化:补 accent-2 渐变终点 |
  | warm_gold | 深棕 #161311 + 金 #d4af37 | 深化 |
  | ink_green | 墨绿 #0d1f1a + 翠绿 #3fd68f | 深化 |
  | minimal_light | 米白 #fafaf7 + 蓝 #2563eb | 深化 |
  | magazine_light | **新增** 米白 + 粗黑 #1c1917 + 点睛红 #dc2626 | 杂志编辑风 |
- 主题切换 = 注入对应变量块;模板只引用变量,禁写死颜色

### S3 kind=web 模板支路

**模板形态**
- `packages/code-scene/templates-web/<name>.html`:自包含单文件
  (内联 `<style>`/`<script>`,引用注入的 design tokens)
- 参数传入:渲染器把 params JSON 注入 `window.__PARAMS__`,页面脚本读取
- 主题传入:`window.__THEME_TOKENS__`(CSS 变量文本,页面插入 `<style>`)

**渲染器 `packages/code-scene/web-worker.mjs`**
- 输入:spec JSON(与现有 spec 同构,`scene: "web:<name>"`)
- 流程:Playwright chromium 启动 → `page.setViewportSize({w,h})` →
  载入模板 HTML → **确定性时间驱动截帧**:
  - 页面所有动画用 WAAPI(`element.animate()`),渲染器逐帧执行
    `document.getAnimations().forEach(a => { a.pause(); a.currentTime = t })`
    然后 `page.screenshot()` → PNG 帧序列
  - 30fps,帧数 = duration × 30
- **不用实时录屏**:录屏掉帧且结果不可复现;时间驱动截帧帧帧确定,
  渲染结果与机器性能无关
- 合成:ffmpeg `framerate=30` 图片序列 → libx264 crf18 yuv420p mp4
- 性能预估:1080×1920 截帧 30-80ms/帧,6s 镜头(180 帧)≈ 10-15s + 编码,
  不慢于 Revideo(实测 4-6s 渲染/1s 成片)
- 时长语义与现有对齐:自然时长不足目标时长时沿用 `padWithLastFrame` 末帧定格补时
  (web-worker 产 nature 时长写入产物 meta,服务层复用 decidePadSeconds)

**服务层(code-scene.ts)**
- 新增 `WEB_TEMPLATES` 注册表:`{ name, paramsSchema, safeZone }`
  (首个条目:`big-number`,schema 同现有 TEMPLATE_LIMITS 校验规则)
- `validateCodeSceneInput` 支持 `template.name` 命中 WEB_TEMPLATES;
  **路由规则(确定无二义):名字在 WEB_TEMPLATES 中 → 一律走 web 渲染器**,
  不再查 Revideo 场景注册表(web 版 big-number 上线即取代 Revideo 版同名模板)
- `doRender` 分支:web 模板 spawn `web-worker.mjs`,复用并发池(视作模板任务,
  非 custom 独占)、超时自适应、质量门禁、资产登记
- `VALID_THEMES` 增加 `magazine_light`

### S4 字幕胶囊(caption_generate.py)
- ass 样式:BorderStyle=3(不透明底盒)、BackColour 深色半透明(&H720A101E,
  即 rgba(10,16,30,.72))、Outline 作 padding、圆角不可控(ass 限制,接受方底)
- 位置:Alignment=2(底部居中)+ MarginV 使字幕垂直中心落入 SUBTITLE_ZONE
  (默认 MarginV=168,即 1080×1920 下距底 168px)
- 模板 safeZone 元数据经渲染产物 meta 传递,合成期优先读取,缺省用默认带

### S5 测试与验收
- `tests/code-scene/web-worker.test.ts`:mock 页面截帧管线(动画 seek 正确性、
  帧数 = duration×30、参数注入)
- `tests/services/code-scene.test.ts`:web 模板校验分支(合法/非法参数、
  magazine_light 主题合法性)
- caption_generate 安全区位置单测(MarginV 落入 SUBTITLE_ZONE)
- big-number HTML 版渲染冒烟(真渲染一次,出样片)
- **验收门槛**:样片用户盲测点头 → 其余 9 模板迁移另立批次

## 三、工程量预估
- S3 web-worker(确定性截帧管线)≈ 全批次一半工时,是最硬的骨头
- S2 tokens + S3 标杆模板 ≈ 1/3
- S1/S4/S5 ≈ 剩余

## 四、非目标(YAGNI)
- 不做 Revideo→web 的 11 模板全量迁移(标杆验收后再议)
- 不做字幕区像素级机器校验(常量约束 + 评审抽查兜底)
- 不做 real-time 录屏模式
- 不动 keynote-leather(横屏数字人整片链路独立)
