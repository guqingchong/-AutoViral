---
name: prompt-compiler
description: 素材生成 prompt 编译器——把分镜镜头编译为各生成模型的公式化 prompt(五槽公式/单运动约束/static显式声明/负面词库),覆盖本地 H3、即梦、Seedance/Dreamina。素材(assets)阶段写任何生成 prompt 前必加载。
type: module
---

# 素材生成 Prompt 编译器

同一个镜头，写成"氛围感画面，高级质感"是浪费 token；写成公式化五槽 prompt 才能稳定出片。本模块把分镜镜头**编译**为生成模型可执行的 prompt——先写统一中间表示（五槽），再按目标 provider 输出。

---

## 一、五槽中间表示（所有视频/图片 prompt 的强制结构）

每个生成镜头先填五槽（Kling/Pika/Runway 官方公式已收敛为此结构）：

```
[主体 Subject] + [主体运动 Action] + [场景 Scene] + [镜头语言 Camera] + [光影氛围 Light/Mood]
```

| 槽 | 要求 | 反例 |
|----|------|------|
| 主体 | 具体化（年龄/着装/状态/数量），每次出现完整重复描述 | "一个人" |
| 主体运动 | **一个主体运动为上限**（多动=形变漂移） | "边走边挥手还转头" |
| 场景 | 地点+时间+关键陈设 | "办公室里" |
| 镜头语言 | 用明确运镜术语，禁用 "cinematic movement" 等模糊词 | "电影感运镜" |
| 光影氛围 | 光源方向+色温+情绪词 | "好看的光" |

**有效长度 60-100 词**，堆满 2500 字符反而降质。迭代时"锁 4 槽改 1 槽"，每次只改一个变量。

## 二、镜头语言术语表（镜头槽只允许用这些词）

| 术语 | 效果 | 适用 |
|------|------|------|
| `push-in / dolly in` | 推近 | 强调/压迫感（焦虑类常用） |
| `pull-back / dolly out` | 拉远 | 揭示全貌/收尾 |
| `tracking / follow` | 跟拍 | 人物移动 |
| `pan left/right` | 横摇 | 环境展示 |
| `tilt up/down` | 俯仰 | 高大主体/压迫感 |
| `orbit` | 环绕 | 主体特写展示 |
| `crane up` | 升降 | 大场景揭幕 |
| `handheld` | 手持晃动 | 纪实/紧张感 |
| `static / locked-off` | 固定机位 | 数据卡/访谈/讲解 |
| `close-up / macro` | 特写 | 情绪/细节 |
| `wide / establishing` | 全景 | 空间上下文 |

**单镜头约束（铁律）**：一个镜头 = 一个主体运动 + 一个镜头运动。静态构图必须**显式声明** `static shot, no camera movement`——不写模型就默认漂移。

## 三、Provider 适配层

五槽中间表示 → 各 provider 的输出差异：

| Provider | 注意点 |
|----------|--------|
| **本地 H3**（local-h3,i2v 主流程） | firstFrame 已给定构图 → prompt 只写**运动+镜头**两槽；对白镜头走 t2v 且台词用分秒锚点（`[0s] 主持人立即开口说：「…」`）；`shotType` 必传 |
| **即梦/Seedance**（云端，hero 镜头） | 完整五槽；支持中文 prompt；运镜词可用中文（推近/拉远/环绕） |
| **Dreamina CLI** | 完整五槽英文 prompt；负面词用 `--neg` 参数传入 |
| **AI 生图**（openrouter/即梦） | 五槽去掉"主体运动"槽，加风格词槽（风格关键词全片统一） |

## 四、负面词库（按场景取用）

```
通用: morphing, distortion, blurry, watermark, text artifacts, jerky motion, extra limbs
人像: deformed face, asymmetric eyes, waxy skin, bad hands
文字/图表: gibberish text, wrong numbers   ← 注:精确数据镜头根本不该走生成,见程序化素材铁律
动作: floating, teleporting, duplicated subject
```

## 五、编译自检清单

- [ ] 五槽是否全部填写且具体？
- [ ] 是否只有一个主体运动 + 一个镜头运动？
- [ ] 静态镜头是否显式声明 static？
- [ ] i2v 是否只写了运动+镜头（没重复描述首帧已有的构图）？
- [ ] 矛盾指令检查（如 extreme close-up 与 full body 同求）？
- [ ] 涉及精确数据/文字？→ **停**，改走程序化素材 API（/api/assets/chart|data-card|snapshot-card），本模块不服务此类镜头

## 六、结构/流程/逻辑镜头不走本模块

涉及结构图、流程图、逻辑链条的镜头不属于 AI 生成范畴——调用 `POST /api/assets/code-scene`(程序化动画,数字/结构 100% 准确)。本模块只服务氛围/场景感画面的生成 prompt。
