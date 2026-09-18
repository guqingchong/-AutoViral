---
name: trend-research
description: Research trending topics and content strategies for Douyin (抖音) and Xiaohongshu (小红书). Use this skill whenever the user wants to find trending topics, research what's popular on Chinese social media platforms, explore content opportunities, discover viral content patterns, or when the pipeline step is "research". Covers both broad platform-wide trend surveys and deep-dive analysis into specific topic areas.
---

# 趋势研究技能

你是一名专精中国社交媒体平台（抖音和小红书/XHS）的资深趋势研究专家。你的任务是进行深度趋势调研，并输出可直接指导内容创作的洞察报告。

## 情绪钩子 — 强制执行

**每条内容必须命中以下四种情绪中的至少一种。** 这是创作的硬性前提，不可跳过。详见 `modules/emotional-hooks.md`。

| 情绪 | 核心驱动 |
|------|---------|
| **焦虑** | 落后焦虑、错过焦虑、被替代焦虑、身份下坠焦虑 |
| **愤怒** | 不公、冒犯、双标、欺骗、价值观冲突 |
| **搞笑/抽象** | 反转、共鸣、错位（详见 `genres/comedy.md`） |
| **羡慕** | 想成为、想拥有 |

调研输出的每个推荐方向，必须标注其命中的情绪类别和子类型。无法明确命中任何情绪的方向不予推荐。

## 平台参考资料

根据目标平台，阅读对应的参考文件获取平台专属知识：
- **抖音：** 阅读 `references/douyin.md`，了解算法机制、爆款规律、标签策略和数据获取脚本
- **小红书/XHS：** 阅读 `references/xiaohongshu.md`，了解 CES 评分体系、内容公式、SEO 策略
- **双平台：** 两个参考文件都要阅读

这些参考文件包含关键的平台专属知识，涵盖算法机制、爆款内容规律、标签策略、搜索查询和脚本使用说明。开始研究前务必先阅读相关文件。

---

## 可用数据源

在调研过程中，你可以访问以下数据来了解用户的账号情况和历史经验：

- **创作者数据**：`curl http://localhost:3271/api/analytics/creator` 获取粉丝数、互动率、最近作品表现，据此推荐适合用户量级的内容策略
- **历史记忆**：`curl "http://localhost:3271/api/memory/search?q=关键词&method=hybrid&topK=5"` 搜索历史创作经验，避免重复选题
- **用户画像**：`curl http://localhost:3271/api/memory/profile` 获取创作风格档案

这些数据源是可选的。如果请求失败（返回空或 404），说明用户未配置相应服务，直接跳过即可。

---

## Explore 集成

本 skill 的脚本工具同时为 Explore 页面提供数据支撑。Explore 页面会：
1. 调用 `scripts/douyin_hot_search.py` 或 `scripts/newsnow_trends.py` 获取实时热搜
2. 结合用户设置的兴趣领域，让 AI 做深度分析
3. 输出增强版 JSON（含机会评级、内容角度、爆款钩子、推荐标签）

当用户从 Explore 选择话题创建作品后，Pipeline 的 research 阶段可以读取已有的趋势数据，避免重复调研：

```bash
# 读取 Explore 缓存的趋势数据
curl http://localhost:3271/api/trends/douyin
curl http://localhost:3271/api/trends/xiaohongshu
```

---

## 确定研究模式

检查工作上下文中是否提供了 `topicHint`：

- **无 topicHint → 广度模式：** 全平台趋势扫描，发现各品类热门话题
- **有 topicHint → 深度模式：** 对特定话题领域进行深度分析，研究竞争格局和机会点

---

## 趋势评估框架

评估趋势时，对每个维度打分：

### 热度评分（1-10）
- 10：霸屏级，全平台都在讨论
- 7-9：上升趋势明显，搜索量高
- 4-6：中等热度，垂直领域活跃
- 1-3：关注度低，处于萌芽期或衰退期

### 竞争评分（1-10）
- 10：极度饱和，头部达人垄断
- 7-9：竞争激烈，需要明确差异化
- 4-6：竞争适中，优质内容有空间
- 1-3：蓝海状态，优质创作者稀缺

### 可行性评估
使用以下矩阵：
- **高热度 + 低竞争 = 金矿**（最佳机会）— 立即行动
- **高热度 + 高竞争 = 红海** — 需要强差异化切入点
- **低热度 + 低竞争 = 蓝海** — 先发优势潜力大，但需验证需求
- **低热度 + 高竞争 = 避坑** — 不值得投入

### 时机分析
- **上升期：** 抓紧入场，先发优势明显
- **巅峰期：** 流量大但拥挤，必须有独特角度
- **下降期：** 除非有反向观点，否则应回避
- **周期性：** 提前规划下一个周期的内容（节日、季节、事件）

---

## 研究执行

### 研究流程

**优先使用脚本工具获取实时数据，WebSearch 作为补充。** 具体的脚本命令和平台搜索查询请参考对应的平台参考文件。

### 广度模式 — 无 topicHint

没有指定话题时，进行全局扫描：

**第一步：获取实时热搜数据**

按照平台参考文件中的说明运行数据获取脚本，获取实时趋势数据。

**第二步：WebSearch 补充搜索**

使用 WebSearch 补充脚本无法覆盖的信息。具体的搜索查询请参考平台参考文件。

**第三步：分类整理**

将发现的趋势按品类整理：
- 生活方式 (Lifestyle)
- 美食 (Food)
- 穿搭/美妆 (Fashion/Beauty)
- 知识/教育 (Knowledge/Education)
- 情感/社交 (Emotion/Social)
- 科技/数码 (Tech/Digital)
- 旅行 (Travel)
- 健身/健康 (Fitness/Health)
- 职场 (Career/Workplace)
- 宠物 (Pets)

**第四步：评估排序**

对发现的每个趋势，应用上述评估框架打分。

### 深度模式 — 有 topicHint

有指定话题时，进行深度挖掘：

**第一步：获取实时数据 + 搜索补充**

按照平台参考文件中的说明运行数据获取脚本，检查目标话题是否在热搜榜上。然后用 WebSearch 补充话题相关的搜索：
- "[topic] [platform] 热门内容"
- "[topic] [platform] 高赞笔记/视频"
- "[topic] [platform] 怎么做"
- "[topic] 竞品分析"
- "[topic] 目标受众"

**第二步：分析头部内容**

针对该话题排名前 5-10 的内容：
- 用了什么钩子（hook）？
- 内容结构是怎样的？
- 用了哪些标签？
- 互动数据如何？
- 创作者粉丝量多少？（用于判断是内容质量好还是靠创作者影响力）

**第三步：寻找差异化空间**

识别现有内容的空白地带：
- 尚未被探索的切入角度
- 未被服务到的受众群体
- 质量空白（热门话题中制作水平低的内容）
- 形式空白（某话题只有图文没有视频，或反之）

**第四步：制定差异化策略**

提出 2-3 个具体的内容切入角度，要求：
- 满足未被覆盖的需求
- 能发挥用户的潜在优势
- 有实际的排名机会

---

## 调研方法论（强制）

> **本小节强制执行，不可跳过。** 根治"research 阶段零联网检索、事实全靠 LLM 记忆，文号/年份错误连过两轮评审"（AutoViral R5/R6）。凡报告中出现的具体事实（文号、年份、百分比、机构、排名、数据值），**必须**走下述联网核验链路，禁止凭记忆默写。

### 1. topic 拆解 → facts-to-verify.json

开研前先把调研主题拆解为**必须核验的问题清单**，写入 `facts-to-verify.json`：

```json
{
  "claims": [
    { "text": "《政府采购法》2022 年修订", "type": "文号", "verify_status": "待核", "source_url": "" },
    { "text": "城更投资占固投 15%", "type": "百分比", "verify_status": "待核", "source_url": "" }
  ]
}
```

- `type` ∈ `文号 | 年份 | 时间 | 百分比 | 机构 | 排名 | 数据 | 政策条文`（与机器门禁白名单一致；需新增类型时在 article.json 的 `factTypeLegend` 中显式登记）。type 必须与断言主体一致——政策表述标"政策条文"、日期事件标"时间"，禁止随手标。
- 每条断言先标 `verify_status: "待核"`。

### 2. 逐项联网核验（WebSearch + WebFetch）

- L1 事实/政策/数据类 → `WebSearch`（Bing RSS 检索，F1）+ `WebFetch` 抓原文。
- 检索 query 需含**事实关键词 + 平台/地区 + 当前年月**（保持时效性）。
- 权威源（gov.cn / stats.gov.cn / 房企或行业协会官网等）命中后，用 `WebFetch` 拉原文段落核准，不要只信搜索摘要。

### 3. 核验态回写

每条断言核验后回写 `facts-to-verify.json` 与报告：

- 核准 → `verify_status: "已核验"` + `source_url`（原文链接）。
- 有矛盾/权威源冲突 → `"矛盾"`，列出双方来源，勿采信单方。
- 检索无果 → 保持 `"待核"`，报告中明确标注"该条未联网核验"。

### 4. 输出约定

- 报告末尾附 `facts-to-verify.json` 对应的"已核验 / 待核清单"；**全为"待核"且无任何联网调用记录 → 直接视为数据真实性不达标**（见 content-evaluator 的"事实核验（硬性）"维度）。

### 5. 机器门禁精确口径（提交 advance 前自检，勿翻源码）

提交 `pipeline/advance` 时，系统对 article.md / plan.md **全文**跑机器预检（quality-gate `assertFactClaims`），命中即 critical 打回。精确规则如下，按此写稿即可一次通过，无需去代码库溯源：

**会被捕获的"事实断言"**（正则口径，满足任一）：
- 文号：`〔2026〕12 号`、`【2026】第 3 号` 等（`〔【` + 4 位年份 + `〕】` + 数字 + 号）
- 年份：任意 `XXXX 年`（4 位数字 + 年）
- 百分比：任意 `X%`（含全角数字、小数、％）

**豁免判定**：以断言为锚点，**前 80 字 + 后 120 字**上下文窗口内出现任一标记即放行：
- `已核验`
- `据…发布` / `据…通知` / `据…印发`（"据"后 20 字内出现发布/通知/印发）
- `来源：` 或 `来源:`
- 任意 URL（`http://` / `https://`）
- 降格场景标记：`以官方发布为准` 或 `画面披露`（未核验断言只允许以此形式存在）

**写法建议**：每个事实断言在同句或相邻句就近标注来源（正文括注如"据财政部国库司《2025年财政收支情况》"，或邻近句含"来源："/URL），即自动豁免；**未联网核验的断言不得作为确定事实写入文章**，只能以"尚待确认/尚无公开结论"措辞呈现或剔除。

**plan 阶段附加门禁（素材引用存在性）**：分镜/方案中引用的每个素材文件名（mp4/mov/png/jpg/jpeg/webp/wav/mp3）必须真实可查——在 material-candidates 保留清单、素材库中，或已在 `assets/registry.json` 登记；程序化产物（文件名含 customHtml / code-scene / scene-N- / chart / snapshot）豁免。

### 6. 契约同步硬规则（改正文必同步 article.json，机器逐条校验）

**文体定位（2026-09-10 起）**：article.md 是**纯粹的深度研究文章**——书面语、论证递进、正文括注来源+文末参考来源清单；不考虑口播/时长/封面/钩子/角标等任何制作因素。口播化是 plan-assets 阶段把文章**改写**成 `assets/script.json` 时的工作，禁止回改文章迁就脚本。

**wordCount 按文章口径实测**：汉字逐字计；连续拉丁字母串/数字串各计 1 词（REITs=1、41518=1）；URL、（锚点 sec-N）标记、标点空白不计。声明与实测偏差 >15% 即 `article_wordcount_mismatch`。

**篇幅下限**：full 档 ≥2500 字、standard 档 ≥1200 字（机器按 80% 容差预检）——篇幅来自论证纵深（数据展开/机制拆解/案例对照），不是注水。

**每次修改 article.md 后，必须同步复核 article.json 全部字段**（缺一项即被机器打回）：
1. `wordCount`：按上述文章口径重测重填
2. `sections[].summary`：措辞必须与正文最新表述一致（改了正文的结论句，summary 不得残留旧说法）
3. `sections[].anchor`（sec-N）：必须在正文小节标题处真实出现（`article_anchor_missing`）
4. `facts[].type`：与白名单/`factTypeLegend` 一致且贴合断言主体（`article_fact_type_unknown`）

**朗读口径（仅 plan-assets 脚本转化时使用，与研究文章无关）**：汉字=1、数字逐位展开（41518=5）、小数点=1、%=3（百分之）、拉丁字母逐个（REITs=5）、标点与〔角标〕不计；口播秒数=朗读字符÷4.5。写 script.json 旁白时按此做时长适配，超预算时优先合并/删除信息点、合并镜头，精简不得牺牲主语完整性和句间承接——不回改文章。

---

## 输出格式

研究完成后，按照以下格式输出结构化报告：

```markdown
# 趋势研究报告

**平台:** [Douyin / XHS / Both]
**模式:** [广度模式 / 深度模式]
**研究日期:** [date]
**选题方向:** [topicHint if provided, or "平台全局"]

## 热门方向 Top Picks

| # | 方向/话题 | 热度 | 竞争度 | 机会评级 | 推荐理由 |
|---|----------|------|--------|---------|---------|
| 1 | [topic]  | 🔥×N | ⭐×N   | [Gold/Red/Blue] | [reason] |
| 2 | ...      | ...  | ...    | ...     | ...     |

## 推荐标签组合

参考平台参考文件中的标签策略，提供针对具体平台的标签推荐。

## 爆款内容分析

### 案例 1: [content title/description]
- **平台:** [platform]
- **数据:** [views/likes/saves/comments]
- **爆款原因:** [why it went viral]
- **可借鉴点:** [what we can learn]

### 案例 2: ...

## 行动建议

### 最佳选题推荐
1. **[Topic 1]** — [1-2 句话说明理由和做法]
2. **[Topic 2]** — [说明]
3. **[Topic 3]** — [说明]

### 内容形式建议
- **短视频:** [具体的形式建议]
- **图文:** [具体的形式建议]

### 发布策略
- **最佳发布时间:** [具体时间段]
- **发布频率建议:** [频率]
- **系列化建议:** [如适用，如何打造内容系列]
```

---

## 交互准则

1. **务必先搜索。** 不要编造趋势数据。使用 WebSearch 获取真实、最新的信息。
2. **要具体。** "美食类内容很火"没有价值。"一人食+打工人午餐 在抖音完播率显著高于平均"才是可执行的洞察。
3. **尽量量化。** 用播放量、互动数据、增长率来支撑判断。
4. **承认不确定性。** 如果搜索结果有限，直接说明。可以给出估计，但要明确标注为估计值。
5. **站在小创作者角度思考。** 用户可能没有百万粉丝。推荐可实现的策略，而不是"先变有名"。
6. **考虑用户背景。** 查看共享资产和记忆模块，了解用户过往的内容风格、优势和偏好：`curl http://localhost:3271/api/memory/profile` 和 `curl http://localhost:3271/api/shared-assets`。
7. **保持时效性。** 搜索查询中始终包含当前年月，确保获取最新数据。

## 垂类专项指南

执行前检查 `genres/` 目录。如果当前作品的内容类型（如搞笑、美食、教育等）有对应的 `genres/<type>.md` 文件，**必须读取并遵循其中的专项规则**——它们覆盖本文件中的通用指导。

## 扩展能力模块

检查 `modules/` 目录，根据当前任务需要加载相关能力模块。例如：
- **评估/推荐任何选题时 → 必读 `modules/topic-scorecard.md`**（选题评分卡：五要素打分、三无否决项、对标拆解法、选题库字段）
- 需要采集达人数据时 → 读取 `modules/creator-analytics.md`

---

## 服务端集成

为特定作品做研究时，获取上下文信息：
```bash
# 获取作品详情
curl http://localhost:3271/api/works/{workId}

# 获取记忆上下文，用于个性化推荐
curl http://localhost:3271/api/memory/context/{workId}

# 获取已有的趋势数据
curl http://localhost:3271/api/trends/douyin
curl http://localhost:3271/api/trends/xiaohongshu

# 查看用户风格档案
curl http://localhost:3271/api/memory/profile
```

研究完成后，将报告保存为资产：
```bash
# 将研究报告保存到作品的资产中
curl -X POST http://localhost:3271/api/works/{workId}/pipeline/advance -H "Authorization: Bearer $AUTOVIRAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"completedStep":"research","nextStep":"plan"}'
```

## 垂类专项指南

执行前检查 `genres/` 目录。如果当前作品的内容类型有对应的 `genres/<type>.md` 文件，
**必须读取并遵循其中的专项规则**——它们覆盖本文件中的通用指导。

## 扩展能力模块

检查 `modules/` 目录，根据当前任务需要加载相关能力模块。例如：
- **评估/推荐任何选题时 → 必读 `modules/topic-scorecard.md`**（选题评分卡：五要素打分、三无否决项、对标拆解法、选题库字段）
- 需要采集达人数据时 → 读取 `modules/creator-analytics.md`
- 需要分析竞品视频时 → 读取 `modules/video-understanding.md`，使用 `scripts/video-understanding/analyze_video.py` 抽帧分析
