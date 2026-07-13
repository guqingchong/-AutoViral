---
name: showcase
description: 展示类内容（Vlog、旅行、美食制作过程、生活方式）的素材生成专项规则。覆盖个人 Vlog、旅行记录、美食烹饪、手工制作、开箱体验等第一人称视角品类。
---

# 展示类 — 素材生成阶段专项指南

展示类内容的视觉核心是 **真实感和代入感**。画面应该像"有人在那里亲身体验"而非"摆拍宣传片"。第一人称视角、自然光线、生活化细节是关键。

---

## 视觉风格方向

### 展示子类型与美学定位

| 子类型 | 美学参考 | 色调策略 | 镜头语言 |
|--------|---------|---------|---------|
| 个人 Vlog | Emma Chamberlain, 你好竹子 | 自然暖调，略褪色，胶片感 | 第一人称手持，晃动真实，跳切 |
| 旅行记录 | 房琪kiki, 燃烧的陀螺仪 | 高饱和暖调，金色/日落调 | 航拍+延时+地面主观视角混合 |
| 美食制作 | 日食记, 绵羊料理 | 暖黄高饱和，食物特写暖光 | 微距操作细节，俯拍全局+侧拍过程 |
| 手工/DIY | 小爽姑娘, 折纸教程 | 柔和白光，台面拍摄 | 正上方俯拍为主，手部过程记录 |
| 开箱体验 | 老师好我叫何同学 | 高对比科技感/自然生活化 | 中景+面部反应+产品特写切换 |

### 展示类美学铁律：拒绝 AI 感

- **加入"不完美"元素**：桌上的一杯半满的水、略皱的桌布、自然散落的工具
- **光线自然化**：`natural window light, mixed lighting, realistic shadows`
- **构图不要太完美**：`candid framing, slightly off-center, snapshot aesthetic`
- **表情不要太精致**：`natural expression, imperfect smile, caught in the moment`
- **使用生活化参考词**：`shot on iPhone, daily vlog aesthetic, realistic lifestyle photography`

---

## 图片生成提示词模板

### Vlog 生活场景模板

```
[质量前缀], [景别] of [人物], [动作], [环境描述],
natural lighting, [时间], [氛围关键词], candid lifestyle photography,
iPhone photography style, authentic daily life aesthetic
```

### 美食制作过程模板

```
[质量前缀], [拍摄角度] of [菜品/操作],
[动作描述], [厨房/桌面环境], warm food photography lighting,
[餐具/食材细节], appetizing, mouth-watering
```

### 手工/开箱过程模板

```
[质量前缀], close-up of hands performing [操作],
[桌面环境], bright natural lighting, [辅助道具],
step-by-step process, DIY aesthetic, clean organized workspace
```

---

## 视频生成策略

### 各展示类型的视频策略

| 类型 | 推荐方式 | 提示词关键词 |
|------|---------|-------------|
| Vlog 行走 | `image2video` + 手持晃动 | `first person walking, natural hand camera movement, POV shot` |
| 料理过程 | `image2video` + 手部微动 | `hands working with food, steam rising, subtle movement` |
| 旅行风光 | `text2video` 直接生成 | `aerial drone shot, slow sweeping pan, cinematic landscape` |
| 开箱 | `image2video` + 面部+手部 | `hands pulling out object, genuine surprise expression` |
| 手工制作 | 静态序列+后期 | 不推荐 AI 视频（手部细节太多） |

### 展示类视频"破功"预防

1. **展示类对 AI 伪影的容忍度最低**——用户一眼就能看出"这不是真实拍摄"
2. **如果 AI 视频有明显破绽**，切换为首帧图片+剪映后期效果
3. **旅行类优先用全网搜索下载真实视频素材**（yt-dlp），而非 AI 生成

---

## 风格一致性指南

| 要素 | 要求 | 原因 |
|------|------|------|
| **一天内的光线** | Vlog 如设定为"早晨"，所有镜头保持晨光 | 室内光线变化破坏时间沉浸感 |
| **服装连续性** | 当天 Vlog 不换装 | Vlog 是连续时间线记录 |
| **餐具/台面** | 同一道菜的烹饪过程，台面物品位置不乱 | 后期跳剪时视觉不连贯 |
| **整体色调** | 旅行 Vlog 全程用相同的风格滤镜描述 | 色调一致性是博主品牌的关键 |

### 展示类特有的 prompt 技巧

- **使用具体地名/店名**增加真实感
- **加入环境音的描述**影响模型的氛围判断
- **描述气味**帮助模型构建更丰富的场景
- **不要用 perfect/immaculate/flawless**——这些词触发 AI 的"完美模式"

---

## 质量检查标准

### 展示类专属检查项

- [ ] 画面是否看起来像"真人拍摄"而非"AI 生成的完美场景"？
- [ ] 人物表情是否自然？
- [ ] 光线是否符合该场景的自然规律？
- [ ] 手部/工具在视频中的运动是否自然？
- [ ] 食物/产品是否看起来真实可食用/可使用？
- [ ] 场景中的物品摆放是否符合生活逻辑？
- [ ] 同一 Vlog 的所有镜头是否给人一种"同一天"的感觉？

### 重新生成条件

| 问题 | 严重性 | 处理 |
|------|--------|------|
| "AI 完美感"过强 | **致命** | 添加 `casual, candid, snapshot aesthetic` 等反完美关键词 |
| 表情做作 | **严重** | 改为 `natural expression, caught off guard, genuine smile` |
| 光线不真实 | **严重** | 具体化光源 `window light from left, realistic shadow pattern` |
| 物品不合理 | **中等** | 检查 prompt 中物品的逻辑关系 |
| 食物没有食欲 | **中等** | 加入 `steam rising, glistening oil, fresh ingredients` |

---

## 常见失败模式与修复

| 失败模式 | 现象 | 根因 | 修复 |
|---------|------|------|------|
| **假脸感** | 人物看起来像 CG 或过度磨皮 | 使用了 studio 系光线 | 用 `authentic skin texture, natural pores, candid lighting` |
| **美食塑料感** | 食物看起来不像真的 | 光线太均匀 | 加入 `steam, texture, irregular shape, hand-made look` |
| **时空混乱** | Vlog 中白天突然变黑夜 | 光线描述在镜头间不一致 | 统一 `natural morning sunlight` 类关键词 |
| **手部畸形** | 制作过程中手部扭曲 | AI 对手部视频生成差 | 换成静态帧图片+剪映关键帧动画 |
| **过度精致** | 画面像广告不像 Vlog | prompt 中用了过多 professional 类词 | 用 `authentic, casual, real life, unstaged` |
