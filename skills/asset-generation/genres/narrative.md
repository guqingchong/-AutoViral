---
name: narrative
description: 叙事类内容（科幻短片、微电影、剧情向、故事片）的素材生成专项规则。覆盖科幻、情感剧情、悬疑、微电影等需要连贯叙事和角色一致性的品类。
---

# 叙事类 — 素材生成阶段专项指南

叙事类内容的视觉核心是 **连贯的故事讲述**。与传统图文/短视频不同，叙事类的每一帧都是故事链条的一环，角色、环境、光线必须在镜头间保持逻辑一致。

---

## 视觉风格方向

### 叙事子类型与美学定位

| 子类型 | 美学参考 | 色调策略 | 镜头语言 |
|--------|---------|---------|---------|
| 科幻/赛博朋克 | Blade Runner 2049, 流浪地球 | 冷青/洋红调，高对比，霓虹蓝紫 | 广角+推轨，大景深建立世界观 |
| 悬疑/惊悚 | 隐秘的角落, 沉默的真相 | 低饱和度，暗调，青绿/灰绿 | 手持晃动，浅景深，特写压迫感 |
| 情感/剧情 | 海街日记, 你好李焕英 | 暖黄/胶片，柔和过渡 | 固定镜头为主，中景叙事，缓慢推近 |
| 喜剧剧情 | 年会不能停, 爱情神话 | 自然暖调，略提高饱和度 | 中全景为主，稳定构图 |
| 微电影/文艺 | 是枝裕和风格 | 日系低对比，暖灰调 | 固定长镜头，留白构图 |

### 画面比例规则

- **抖音发布**：全程 9:16 竖屏。叙事类必须考虑竖屏下的构图适配，避免横屏裁剪导致关键信息丢失
- **小红书图文**：3:4 电影感比例，可加上下黑边模拟宽银幕
- **B站/长视频**：使用 16:9 横版，prompt 指定 `--ar 16:9`

---

## 角色一致性与多帧叙事（核心难点）

叙事类最大挑战是 **同一角色在不同场景/情绪下的外观一致性**。严格执行以下流程。

### 角色锚定流程

```bash
# 第1步：生成角色定妆照（锚定图）——所有镜头的人物参考基准
python3 skills/asset-generation/scripts/openrouter_generate.py \
  --prompt "Chinese male actor, mid-30s, sharp jawline, short black hair with side part, wearing a dark grey wool coat over a white collared shirt, serious expression, cinematic portrait, studio lighting, shallow depth of field, f/1.8" \
  --seed 42 --ar 9:16 --size 4K \
  --output {workDir}/assets/reference/character-01.png

# 第2步：用定妆照生成不同场景/情绪下的镜头
python3 skills/asset-generation/scripts/openrouter_generate.py \
  --prompt "same person as reference image: Chinese male actor, mid-30s, sharp jawline, short black hair with side part, wearing a dark grey wool coat over a white collared shirt. Standing on a rainy city street at night, holding an umbrella, looking up with worried expression, cinematic lighting, neon reflections on wet pavement, Blade Runner aesthetic, blue-teal color grading" \
  --ref-image {workDir}/assets/reference/character-01.png \
  --seed 42 --ar 9:16 --size 4K \
  --output {workDir}/assets/frames/frame-01.png

# 第3步：不同服装/时间线——保持人脸一致，更换服装描述
python3 skills/asset-generation/scripts/openrouter_generate.py \
  --prompt "same person and face as reference image: Chinese male actor, mid-30s, sharp jawline, short black hair with side part. NOW wearing a casual grey hoodie and jeans, sitting in a bright kitchen, morning sunlight, drinking coffee with a tired expression, natural warm lighting, lifestyle documentary style" \
  --ref-image {workDir}/assets/reference/character-01.png \
  --seed 42 --ar 9:16 --size 4K \
  --output {workDir}/assets/frames/frame-02.png
```

### 多角色同框处理

两个角色同框时，**每个人都需要独立锚定图**，生成时把两张参考图都传入：

```bash
python3 skills/asset-generation/scripts/openrouter_generate.py \
  --prompt "two characters in conversation: Character A (ref image 1) is a man in his 30s in a grey coat, Character B (ref image 2) is a woman in her 20s in a red dress. Sitting at a candlelit dinner table, intimate atmosphere, warm golden lighting, shallow depth of field, cinematic composition" \
  --ref-image {workDir}/assets/reference/character-01.png \
  --ref-image {workDir}/assets/reference/character-02.png \
  --seed 42 --ar 9:16 --size 4K \
  --output {workDir}/assets/frames/frame-03.png
```

---

## 提示词模板（按叙事阶段）

### 建立镜头 (Establishing Shot) 模板

```
[质量前缀], wide establishing shot of [地点/环境], [时间/天气], [氛围关键词],
[光线描述], cinematic composition, anamorphic lens, [色调风格]
```

### 人物中景 (Medium Shot) 模板

```
[质量前缀], medium shot of [角色描述], [动作/表情], [角色在场景中的位置],
[环境描述], [光线描述], [镜头参数], [色调风格], [情绪关键词]
```

### 特写 (Close-up) 模板

```
[质量前缀], extreme close-up of [主体细节], [微表情/细节动作],
shallow depth of field, [光线强调], [色调风格], intense mood
```

### 动作/追逐场景模板

```
[质量前缀], dynamic shot of [角色描述], performing [动作], [环境],
wide angle, motion blur, dramatic lighting, fast-paced, [色调风格], cinematic action sequence
```

---

## 视频生成策略

### 运镜控制

叙事类运镜必须服务于 **故事节奏**，而非单纯追求视觉效果。

```bash
# 情绪场景：缓慢推镜
dreamina image2video \
  --image {workDir}/assets/frames/frame-01.png \
  --prompt="Camera very slowly pushes in from medium shot to close-up, character breathing gently, subtle eye movement, rain continuing outside window, warm cozy atmosphere, cinematic 24fps feel" \
  --duration=6 --model_version=seedance2.0 \
  --poll=120

# 悬疑场景：手持微晃
dreamina image2video \
  --image {workDir}/assets/frames/frame-02.png \
  --prompt="Slight handheld camera wobble, slow pan right to reveal something off-screen, tense atmosphere, realistic motion, shallow depth of field" \
  --duration=5 --model_version=seedance2.0 \
  --poll=120

# 科幻场景：环绕推进
dreamina image2video \
  --image {workDir}/assets/frames/frame-03.png \
  --prompt="Camera orbits slowly around the character in a semicircle, holographic displays flickering, subtle particle effects in air, cinematic smooth movement" \
  --duration=5 --model_version=seedance2.0 \
  --poll=120
```

### 多帧叙事工作流（最推荐叙事类使用）

`multiframe2video` 可一次性生成多镜头连贯叙事：

```bash
dreamina multiframe2video \
  --images frame-01.png,frame-02.png,frame-03.png,frame-04.png \
  --transition-prompt="Character walks from rain into the building entrance" \
  --transition-prompt="Character enters elevator, doors closing" \
  --transition-prompt="Elevator doors open to reveal futuristic office, character steps out" \
  --transition-duration=4 --transition-duration=3 --transition-duration=4 \
  --poll=180
```

### 模型选择参考

| 叙事目的 | 推荐模型 | 生成方式 | 提示词重点 |
|---------|---------|---------|-----------|
| 对话场景 | Seedance 2.0 | `frames2video` 首尾帧 | 轻微镜头呼吸，不要大幅移动 |
| 情绪渲染 | Seedance 2.0 | `image2video` 单图驱动 | 缓慢推近/环绕，强调氛围 |
| 动作戏 | Seedance 2.0 | `image2video` | 动态模糊，快速切换，广角 |
| 闪回/梦境 | 3.5pro | `multiframe2video` 多帧 | 跳切风格，色彩扭曲 |
| 长对话 | — | 分割为多个短镜头合成 | 每个镜头不超过5秒 |

---

## 风格一致性指南

### 必须锁定的叙事参数

| 参数 | 锁定方式 | 原因 |
|------|---------|------|
| **Seed** | 整组使用同一个 `--seed` | 保证色调、氛围倾向一致 |
| **角色定妆照** | 所有镜头以同一张 `--ref-image` 为基准 | 角色面部一致性 |
| **角色描述文本** | 每张图的 prompt 中原样复制完整的角色外观 | 模型不会自动记忆 |
| **色调描述** | 每帧 prompt 末尾重复色调关键词 | 避免镜头间色温跳跃 |
| **镜头焦段** | 同场景内的镜头焦段保持一致 | 避免变焦跳跃感 |

### 不可打破的一致性规则

1. **同一场景内**：人物服装、发型、妆容、道具位置不得变化
2. **时间连续性**：白天到黄昏到夜晚的过渡必须通过场景描述控制
3. **环境一致性**：场景内的标志性物品在同一场景内的位置和状态必须合理
4. **颜色分级**：整部短片的色调风格应统一，除非有明确的叙事理由

---

## 质量检查标准

### 叙事类专属检查项

- [ ] 角色面部特征在所有镜头中一致（脸型、五官比例、发型）
- [ ] 同一场景内的服装、道具没有凭空出现或消失
- [ ] 色调和光线在同一场景内保持一致
- [ ] 镜头焦段和构图符合该场景设定的叙事目的
- [ ] 视频运镜的节奏与叙事情绪匹配
- [ ] 视频片段间没有跳帧或运动不连贯
- [ ] 画面中没有被 AI 扭曲的人脸、手部或文字
- [ ] 科幻类：科技元素的视觉风格一致

### 必须重新生成的情况

| 问题 | 严重性 | 处理方式 |
|------|--------|---------|
| 角色面部不一致 | **致命** | 废弃，用锚定图+更强提示词重写后重生成 |
| 场景跳变 | **致命** | 废弃，检查环境描述是否在 prompt 中准确 |
| 色调突变 | **严重** | 废弃，统一色调关键词后重生成 |
| 服装错误 | **严重** | 如无法修复则废弃 |
| 运动不自然 | **中等** | 调整视频 prompt 的运动描述 |
| 轻微 AI 伪影 | **中等** | 降低运动速度或切换模型重试 |

---

## 常见失败模式与修复

| 失败模式 | 现象 | 根因 | 修复 |
|---------|------|------|------|
| **人脸漂移** | 下一张图的角色长相不一样 | 未用 `--ref-image` | 始终 `--ref-image` + 完整复制角色描述 |
| **服装幻觉** | 角色突然换了衣服又变回来 | prompt 中服装描述不一致 | 检查每帧 prompt 的服装描述是否一致 |
| **场景跳跃** | 连续镜头背景完全不同 | 环境描述不够具体或 seed 不同 | 固定 seed，环境描述包含标志性元素 |
| **情绪断裂** | 光线/色调在中途变了 | 色调关键词遗漏 | 用统一色调后缀附加到每帧 |
| **运动过快** | 视频生成中角色动作太夸张 | 视频 prompt 使用了过强的运动词汇 | 用 gentle, subtle, slight 替代 rapid, fast |
| **多角色混淆** | 两个角色特征互相融合 | 单个 prompt 描述多角色时模型混乱 | 分开生成单角色画面再合成 |

---

## 叙事类 BGM 策略

| 叙事段落 | BGM 方向 | 提示词示例 |
|---------|---------|-----------|
| 开场建立 | 氛围铺垫，缓慢铺陈 | `ambient cinematic pad, slow strings, building anticipation, 60 BPM, minor key` |
| 情感高潮 | 弦乐/钢琴驱动 | `emotional orchestral, sweeping strings, piano melody, crescendo, 80 BPM, D major` |
| 悬疑推进 | 低音驱动，不和谐音 | `tense ambient, low bass drone, subtle percussion, uneasy atmosphere` |
| 科幻场景 | 电子合成器 | `synthwave, arpeggiator, analog synth pads, retro futuristic, 90 BPM` |
| 日常叙事 | 轻快原声 | `acoustic guitar fingerpicking, light percussion, warm and natural` |
