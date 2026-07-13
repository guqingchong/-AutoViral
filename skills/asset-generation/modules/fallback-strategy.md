---
name: fallback-strategy
description: 受阻时的系统性降级策略——质量优先，最小让步
---

# 受阻降级策略

## 核心原则
- **质量优先**：宁可不交付，不可降质交付
- **最小让步**：每一级降级都选择对最终内容质量影响最小的替代方案
- **透明决策**：涉及质量降级的决策必须告知用户并获得确认
- **前置检测**：批量执行前做样本测试和环境检测，把问题拦在源头

## 快速决策树

```
遇到阻碍
├── 内容安全审核被拒？
│   └→ 改写 prompt 去敏感词 → 换模型版本 → 告知用户选择
├── API 限流/排队？
│   └→ 并行提交 → 切换 fast 模型 → 告知预计时间
├── 服务不可用？
│   └→ 告知用户 → 给修复指令 → 切换备用服务
├── 参数不支持？
│   └→ 查 -h 确认 → 自动调整到合法值 → 告知用户
├── 环境依赖缺失？
│   └→ 运行 check_environment.py → 用替代方案 → 告知用户安装方法
├── 生成质量不达标？
│   └→ 自检 → 调整 prompt 重试(最多3次) → 展示给用户决定
└── 重试3次仍失败？
    └→ **停止。告知用户当前阻塞，不要继续尝试或静默降质。**
```

## 降级场景与标准路径

### 1. 内容安全审核被拒

**触发信号**：`PROHIBITED_CONTENT`、`SAFETY_FILTER`、`content policy`、返回空结果

**标准路径**：
```
Level 1: 改写 prompt 去除敏感词，保留原命令（保住首帧/画面控制力）
  - 军事 → 改为"科幻战斗""未来冲突"
  - 暴力 → 改为"动作场景""激烈对抗"
  - 性感 → 改为"时尚大片""优雅人像"
  - 医疗 → 改为"科技健康""生命科学"
  Level 2: 换模型版本（seedance2.0 → 3.0 / gemini-2.0 → gemini-2.5）
  Level 3: 告知用户当前情况，请用户选择：
    a) 接受降级方案（如 text2video，会丢失首帧控制力）
    b) 调整首帧内容后重试 image2video
    c) 用户手动上传素材
```
❌ **错误做法**：静默退化到 text2video，丢失首帧控制力却不告知用户
✅ **正确做法**：改写 prompt 重试 → 仍被拒 → 告知用户"image2video 因[X原因]被拒，已尝试改写 prompt，是否接受 text2video？"

**敏感题材预检**：对于军事/暴力/医疗/政治等敏感题材，**批量提交前先做 1 个样本测试**。被拒只浪费 1 次调用而不是全部。

### 2. API 限流/排队

**触发信号**：`rate limit`、`queue position: >1000`、`429 Too Many Requests`、`503 Service Unavailable`

**标准路径**：
```
Level 1: 并行提交多任务（用 & 后台运行），减少总等待时间
Level 2: 切换到 fast/lightning 模型（质量略低但速度快）
Level 3: 设置合理超时（300s），告知用户预计完成时间和排队位置
```
**各服务限流应对**：
| 服务 | 限流表现 | 应对 |
|------|---------|------|
| Dreamina | 排队几万位 | 并行提交 + poll 超时 300s |
| OpenRouter | 429 | 等 30s 重试，最多 3 次 |
| Jimeng | 并发限制 | 串行执行，间隔 5s |
| Gemini | RPM 限制 | 等 10s 重试 |

### 3. 服务不可用

**触发信号**：CLI 未登录、API Key 过期、`connection refused`、`authentication failed`

**标准路径**：
```
Level 1: 检测到后立即告知用户（不要静默跳过）
Level 2: 给出修复指令（如 dreamina login、设置环境变量）
Level 3: 切换到备用服务（Dreamina → OpenRouter Sora / Jimeng）
```

**服务可用性检测命令**：
```bash
dreamina user_credit 2>&1 | head -5       # 即梦
python3 ~/.claude/skills/asset-generation/scripts/check_environment.py --format summary | grep -i openrouter  # OpenRouter（通过环境检测脚本，避免进程参数泄露密钥）
python3 -c "from volcenginesdkarkruntime import Ark; print('OK')"  # Jimeng/Ark
```

### 4. 参数不支持

**触发信号**：`invalid parameter`、`unsupported ratio`、`duration must be`、模型报参数错误

**标准路径**：
```
Level 1: 执行 <command> -h 查看支持的参数范围
Level 2: 自动调整到最近的合法值（如 duration 10s → 8s, ratio 16:9 → 9:16）
Level 3: 告知用户调整了什么参数，为什么
```

**常见参数边界**：
| 服务 | ratio | duration | resolution |
|------|-------|----------|------------|
| Dreamina seedance2.0 | 9:16, 16:9, 1:1 | 4s/6s/8s | 1080p |
| Dreamina seedance3.0 | 9:16, 16:9, 1:1 | 4s/6s/8s/10s | 1080p |
| OpenRouter Sora | 1:1, 16:9, 9:16 | 4s-20s | 480p-1080p |
| Jimeng | 9:16, 16:9 | 3s/5s | 720p/1080p |

### 5. 环境依赖缺失

**触发信号**：`command not found`、`ModuleNotFoundError`、`ffmpeg: Filter not found`

**标准路径**：
```
Level 1: 运行预检脚本检测完整环境能力
  python3 ~/.claude/skills/asset-generation/scripts/check_environment.py
Level 2: 根据检测结果选择替代方案（见下表）
Level 3: 告知用户缺少的依赖及安装方法
```

**环境能力 × 替代方案矩阵**：

| 缺失能力 | 检测命令 | 替代方案 |
|---------|---------|---------|
| ffmpeg drawtext | `ffmpeg -filters 2>&1 \| grep drawtext` | Pillow 逐帧渲染 (subtitle_burn.py) |
| ffmpeg libass | `ffmpeg -filters 2>&1 \| grep ass` | Pillow + subtitle_burn.py (不依赖 ASS 滤镜) |
| ffmpeg libfreetype | `ffmpeg -version \| grep freetype` | Pillow 替代（内置字体渲染） |
| stable-ts (Whisper) | `python3 -c "import stable_whisper"` | caption_generate.py --timestamps 手动模式 |
| moviepy | `python3 -c "import moviepy"` | 用 ffmpeg concat + overlay 命令替代 |
| Pillow | `python3 -c "from PIL import Image, ImageDraw, ImageFont"` | 使用 ffmpeg drawtext（如果可用） |
| Noto Sans CJK 字体 | `ls ~/.autoviral/fonts/` | 下载：`python3 font_manager.py install` |
| dreamina CLI | `which dreamina` | 使用 OpenRouter API 或 Jimeng Ark SDK |

### 6. 生成质量不达标

**触发信号**：画面畸形、文字乱码、风格偏移、分辨率过低、内容不相关

**标准路径**：
```
Level 1: 对照质量检查清单自检（见下方）
Level 2: 调整 prompt 重试（明确问题 + 改进方向），最多 3 次
Level 3: 如果 3 次重试后仍不达标，展示最佳结果给用户决定
  - 选项 A: 接受当前结果（用户确认质量可接受）
  - 选项 B: 更换生成模型/服务
  - 选项 C: 调整创作方向
```

**质量自检清单**（每次生成后必须检查）：
- [ ] 画面主体完整无裁剪/畸形
- [ ] 文字可清晰辨认（有则检查）
- [ ] 风格符合内容类型要求（叙事→电影感，知识→干净专业，展示→自然生活）
- [ ] 分辨率不低于目标平台要求（douyin 1080×1920, xhs 1080×1440）
- [ ] 内容与创作方向一致（不是无关的随机生成）
- [ ] 无明显 AI 伪影（手指畸形、面部扭曲、文字乱码）

**Prompt 重试改进策略**：
1. 第 1 次重试：在 prompt 末尾追加质量约束（如 "high quality, sharp focus, professional lighting"）
2. 第 2 次重试：添加负面提示（如 "no blurred edges, no deformed hands, no text artifacts"）
3. 第 3 次重试：换一个生成模型/服务（如 Gemini → OpenRouter Flux）

**重试上限**：每种生成类型最多重试 **3 次**。3 次后仍未达标 → 告知用户，不继续浪费积分。

### 7. 字幕/BGM 生成失败

**字幕管线降级**：
```
Level 1: caption_generate.py --input video.mp4（auto 语音识别模式）
  失败 ↓ (stable-ts 未安装)
  Level 2: 手动写入时间戳 JSON → caption_generate.py --timestamps captions.json
  失败 ↓
  Level 3: 手动编写 SRT 字幕 → subtitle_burn.py --subs subtitles.srt --style modern
  失败 ↓
  Level 4: 告知用户字幕生成失败，交付无声版本
```

**BGM 生成降级**：
```
Level 1: music-generation.md 脚本生成原创 BGM
  失败 ↓
  Level 2: music-search.md 搜索版权免费音乐 → ffmpeg 截取匹配时长
  失败 ↓
  Level 3: 告知用户，交付无声版本
```

## 前置检测（Pre-flight）

**在开始任何素材生成前，必须先执行**：

```bash
# 完整环境检测
python3 ~/.claude/skills/asset-generation/scripts/check_environment.py

# 或手动逐项检测:
dreamina user_credit                        # 1. 积分/登录状态
ffmpeg -filters 2>&1 | grep -E "drawtext|ass|libass"  # 2. 字幕能力
python3 -c "from PIL import Image,ImageDraw,ImageFont; print('Pillow OK')"  # 3. 图片处理
python3 -c "import moviepy; print('moviepy OK')"  # 4. 视频处理
python3 -c "import stable_whisper; print('stable-ts OK')"  # 5. 语音识别
ls ~/.autoviral/fonts/NotoSansCJKsc-Bold.otf  # 6. 字体
curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer $OPENROUTER_API_KEY"  # 7. API Key
```

## 首帧驱动原则（视频生成铁律）

> **视频生成优先使用 image2video（首帧驱动），text2video 仅作为最后降级方案。**

原因：image2video 以首帧图片为起点生成视频，保留了对画面构图、色彩、主体的精确控制。text2video 完全从文本生成，画面不可控。

**正确流程**：
1. 生成高质量首帧图（Gemini/Flux/Jimeng）→ 用户确认
2. 用首帧图 + 动作描述调用 image2video
3. 仅在 image2video 被拒且改写 prompt 仍失败时，才考虑 text2video
4. 转换前**必须告知用户**会丢失首帧控制力，获得确认后再执行

## 停止条件

以下情况应立即停止，告知用户，**不继续尝试**：

- 同一操作连续失败 3 次（已耗尽重试配额）
- 所有备用服务均不可用
- 核心依赖缺失且无替代方案（如无 ffmpeg 无法合成视频）
- 用户明确要求停止或改变方向
- 预计完成时间超过 30 分钟且用户未确认等待

**记住：静默降质 = 背叛用户信任。宁可告知"目前做不到"，不可交付一个质量不达标的结果。**
