# 06-web 模板迁移约定(2026-09-01)

> 迁移批次共用规范。每个模板一个子 agent 完成:Revideo 版 → `templates-web/<name>.html`。
> 金标准参照:`templates-web/big-number.html`(版式)与 `templates-web/structure-growth.html`(结构与动画编排)。

## 页面契约(必须遵守)

1. 模板是自包含单文件 HTML,1080×1920 直接像素布局,无缩放层
2. 主题:`<style>` 注入 `window.__THEME_CSS__` 后所有颜色/阴影/圆角/缓动引用 `var(--x, fallback)`;
   fallback 用 finance_dark 值。**禁止写死非 fallback 颜色**
3. 参数:`window.__PARAMS__`;`duration`(秒,服务层注入,必有)驱动动画总时长
4. **全部动画用 WAAPI**(`element.animate`, `fill:"both"`);禁止 CSS animation/rAF/setTimeout 驱动
   (渲染器逐帧 seek `document.getAnimations()`,非 WAAPI 动画会失控)
5. 动态文本(计数等)经 `window.__seek = (tSeconds) => {...}` 钩子
6. 安全区:屏幕 y ∈ [1418, 1562] 字幕带,**任何内容禁入**;来源标注放 bottom:170px
7. 字体:`var(--font-display)`;中文不可豆腐块
8. 版式语言:网格底(.grid-bg)、kicker 胶囊、角标、层级字重(kicker 28/标题 64/正文 26-40)——
   与 big-number/structure-growth 保持一致;内容避让左右边距 96px

## 动画质量线(观感 low 根治的验收口径)

- 入场必须弹簧/缓动(cubic-bezier(0.34,1.56,0.64,1) 或 --ease-out),禁止纯线性
- 多元素必须错峰(stagger),禁止同时出现
- 至少一处"精致小动作":遮罩揭示/连线绘制/计数滚动/脉冲强调/呼吸辉光,按模板语义选
- 收尾帧必须是完整信息态(评审抽帧常抽尾帧)

## 参数 schema(与 Revideo 版/TEMPLATE_LIMITS 完全一致,agent 调用契约不变)

| 模板 | 主参数 | items | 约束 |
|---|---|---|---|
| flow-steps | title ≤12 | steps[{title,desc?}] | 2-5 |
| logic-chain | title ≤12 | chain[{text,label?}] | 2-4 |
| compare-split | title ≤12 | left/right:{label,points[1-4]} | — |
| timeline | title ≤12 | events[{time,text}] | 2-5 |
| pyramid | title ≤12 | levels[{text,desc?}] | 2-5(自下而上) |
| quote-card | quote ≤60 | — | source? |
| checklist | title ≤12 | items[{text,done?}] | 2-6 |
| bar-compare | title ≤12 | bars[{label,value}] | 2-5 |

## 自检流程(必须执行)

```bash
# 1. 渲染(8s,参数自拟真实业务内容,禁用 lorem/测试占位)
node packages/code-scene/web-worker.mjs <spec.json>   # spec 结构见既有样例
# 2. 按帧号精确抽帧(-ss 快seek不准,必须用 select=eq(n\,N))
ffmpeg -i out.mp4 -vf "select=eq(n\,30)" -frames:v 1 -y f1.png -loglevel error   # 1s
ffmpeg -i out.mp4 -vf "select=eq(n\,140)" -frames:v 1 -y f2.png -loglevel error  # 中段
ffmpeg -i out.mp4 -vf "select=eq(n\,225)" -frames:v 1 -y f3.png -loglevel error  # 尾帧
# 3. Read 三张图逐项核对:构图/字体/安全区/动画阶段正确性,不达标就改 HTML 重渲
```
