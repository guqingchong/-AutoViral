# 热门音乐搜索与下载模块

当需要为视频寻找合适的背景音乐时，加载此模块。支持搜索抖音热门 BGM、YouTube/B站下载、以及按情绪/BPM 匹配。

---

## 音乐来源优先级

1. **用户共享素材库** — 先检查 `curl http://localhost:3271/api/shared-assets`，用户可能已上传音乐
2. **抖音热门 BGM** — 平台流量加成，搞笑/卡点/梗类内容首选
3. **MiniMax AI 原创** — 教育/科普/剧情类原创 BGM 与歌曲，无版权风险，可精确控制时长与情绪
4. **YouTube/B站搜索** — 曲库最大，找具体歌名或风格词时用，yt-dlp 下载
5. **免版权音乐库** — Freesound 等 CC 授权音源，fallback

---

## 方法零：MiniMax AI 原创生成（首选 - 原创剧情/教育类）

> ⚠️ 接入条件：`~/.autoviral/config.yaml` 或 `.env` 已配置 `MINIMAX_API_KEY`

走 autoviral 自带 HTTP 端点，无需 yt-dlp / ffmpeg：

```bash
# BGM 模式（无人声，纯器乐配乐）
curl -s -X POST http://localhost:3271/api/generate/music \
  -H "Content-Type: application/json" \
  -d '{
    "workId": "WORK_ID",
    "prompt": "lo-fi 雨夜钢琴 BGM，70bpm，慵懒治愈氛围",
    "filename": "bgm-main"
  }'

# 带歌词歌曲模式（有主唱+伴奏）
curl -s -X POST http://localhost:3271/api/generate/music \
  -H "Content-Type: application/json" \
  -d '{
    "workId": "WORK_ID",
    "prompt": "欢快流行电子，节奏感强",
    "lyrics": "[verse]\n清晨第一缕阳光\n[chorus]\n今天充满希望",
    "filename": "song-intro"
  }'
```

成功响应：`{"success":true,"assetPath":"...","previewUrl":"..."}` — 文件直接落盘到 work 的 audio 目录。

### 何时用 MiniMax，何时用 yt-dlp（决策表）

| 场景 | 推荐方式 | 原因 |
|---|---|---|
| 教育/科普/AI/数字孪生类 | ✅ MiniMax | 无现成"梗音乐"加成可言，原创更贴合 |
| 情感/剧情/旁白叙事 | ✅ MiniMax | 需要 BGM 跟着情绪走，可精确控制风格 |
| 短视频 < 60s 且需精确时长 | ✅ MiniMax | 不用 ffmpeg 裁切 |
| 客户特别要求无版权风险 | ✅ MiniMax | AI 生成无版权问题 |
| 搞笑/反转/抽象/梗类 | ❌ → yt-dlp | 强依赖现成抖音热门 BGM 的流量加成 |
| 用户指定了具体歌名 | ❌ → yt-dlp | 直接搜官方 MV 提取 |
| 卡点视频（特定鼓点 hook） | ❌ → yt-dlp | 现成热门 BGM 的鼓点已被用户耳朵记住 |
| 抽象类内容（反差错位） | ❌ → yt-dlp | 需要"真的很 XX"的现成歌曲，AI 生成偏中庸 |

### Prompt 写作建议（提高生成质量）

中英混写 prompt 最稳，建议同时给出：
- **风格**：`lo-fi`、`epic orchestral`、`synthwave`、`ambient piano`
- **情绪**：`uplifting`、`tense`、`melancholic`、`playful`
- **乐器**：`piano lead`、`808 drums`、`acoustic guitar`、`strings pad`
- **节奏**：`70bpm slow`、`128bpm dance`、`free tempo`

> ⚠️ `lyrics` 字段留空时，autoviral provider 会自动填 `[instrumental]` 触发纯 BGM 模式。如果填了内容会生成带主唱的歌曲。

---

## 方法一：从 YouTube/B站搜索下载

```bash
# 搜索并列出结果（不下载）
yt-dlp "ytsearch5:upbeat electronic BGM no copyright 30s" --get-title --get-url --get-duration

# 下载为 MP3（最佳音质）
yt-dlp -x --audio-format mp3 --audio-quality 0 \
  -o "bgm.%(ext)s" "VIDEO_URL"

# 从 B站下载
yt-dlp -x --audio-format mp3 --audio-quality 0 \
  -o "bgm.%(ext)s" "https://www.bilibili.com/video/BVxxxx"
```

### 搜索关键词构造

根据视频内容分析结果，构造搜索关键词：

| 视频类型 | 搜索关键词示例 |
|---------|-------------|
| 搞笑/反转 | `funny meme BGM sound effect`, `搞笑 BGM 无版权` |
| 抽象/过度认真 | `epic orchestral BGM short`, `史诗 BGM 纯音乐` |
| 生活方式 | `chill lofi BGM no copyright`, `轻松 日常 背景音乐` |
| 美食 | `warm acoustic BGM cooking`, `美食 温馨 背景音乐` |
| 科技 | `electronic tech BGM`, `科技感 背景音乐` |

---

## 方法二：从抖音官方 MV 提取

当用户指定了具体歌名时：

```bash
# 1. 搜索官方 MV
yt-dlp "ytsearch1:[歌名] official MV" --get-url --get-title

# 2. 下载音频
yt-dlp -x --audio-format mp3 --audio-quality 0 -o "song.%(ext)s" "MV_URL"

# 3. 裁切高潮段落（大多数歌曲高潮在 50-70% 位置）
ffmpeg -i song.mp3 -ss 120 -to 150 -c copy -y chorus.mp3
```

---

## 方法三：BPM 匹配搜索

当视频分析得出了目标 BPM 时：

```bash
# 搜索特定 BPM 范围的音乐
yt-dlp "ytsearch5:[BPM] bpm BGM no copyright instrumental" --get-title --get-url

# 例如：120 BPM 的电子风格
yt-dlp "ytsearch5:120 bpm electronic BGM no copyright" --get-title --get-url
```

---

## 下载后处理

### 裁切到目标时长

```bash
# 裁切前 30 秒
ffmpeg -i bgm.mp3 -t 30 -c copy -y bgm-trimmed.mp3

# 从高潮开始裁切
ffmpeg -i bgm.mp3 -ss 60 -t 30 -c copy -y bgm-chorus.mp3
```

### 淡入淡出

```bash
ffmpeg -i bgm.mp3 -af "afade=t=in:st=0:d=1,afade=t=out:st=28:d=2" -y bgm-fade.mp3
```

### 验证 BPM 是否匹配

```bash
python3 skills/content-assembly/scripts/beat-sync/detect_beats.py bgm.mp3
```

---

## 音乐选择准则

### 搞笑类（Comedy）

参考 `genres/comedy.md` 中的 BGM 四种战术用法：
- **情绪铺垫-反转**：先下载一段史诗/煽情音乐（铺垫用），再下载一段沙雕/梗音乐（反转用）
- **反差配乐**：画面内容越正经，BGM 越不正经（反之亦然）
- **经典梗音乐**：搜索当下抖音流行的搞笑 BGM

### 抽象类（Abstract）

参考 `genres/comedy.md` 中的 BGM 三种策略：
- **BGM 作为错位的一端**：画面和 BGM 必须来自两个不同世界
- **BGM 纯度要求**：选一首真的很 XX 的歌，不要选"有点 XX"的

---

## 依赖

```bash
pip3 install yt-dlp
# 或 brew install yt-dlp
```
