# 视频策划/规划 Skills 深度调研与选型报告

> 调研时间: 2026-08-14 | 触发问题: Autoviral 是否缺少高水平专业视频策划 skills,应建哪些
> 方法: 2 个并行调研 agent(国际方法论 + 国内平台 SOP) + 本地 skills 审计 + 首片成片(w_20260814_1335_4ff)实证
> 完整原始报告见会话记录;本文为综合结论。

## 一、核心结论

**有必要,但方向不是"补一套视频制作 skills",而是三层精准补缺:**

1. **调度层缺陷(最便宜的最大杠杆)**: 现有 skills 库已含 visual-aesthetics/color-grading/beat-sync/pro-captions 等深加工模块,但 ws-bridge 给创作 agent 的指引只强制读 5 个 SKILL.md,模块仅点名 3 个——首片"无调色无转场"不是知识缺失,是知识未加载。
2. **策划层方法论缺失(本次调研主战场)**: 钩子工程、脚本时间轴、留存工程、包装先行——现有"情绪钩子"模块偏静态,缺少可执行的逐秒结构规则。
3. **四大硬规范无人 skill 化(调研确认的行业空白)**: 分镜语法、声音 LUFS 参数、字幕 CPS 规范、素材 prompt 编译器——连 Remotion 生态(44 万+安装)和 youtuber-skills 等开源包都没覆盖。

## 二、现有资产盘点(本地审计)

| 层 | 现状 |
|---|---|
| 选题层(trend-research) | 平台算法/情绪钩子/数据源,较完整 |
| 策划层(content-planning) | 分镜表+情绪钩子+精品路由(今日增强);缺逐秒结构/钩子工程 |
| 素材层(asset-generation) | 工具路由+程序化素材(昨日新增);prompt 公式未收敛 |
| 合成层(content-assembly) | 字幕/布局/卡点模块齐;混音/质感红线今日刚入 prompt;声音设计只有 BGM 无 SFX |
| 评审层(content-evaluator) | 4 阶段 criteria 偏内容层;无视听语言/留存维度 |

## 三、选型清单(综合两份调研,按优先级)

### P0(立即做,直接抬升成片质量)

| Skill | 内容 | 来源方法论 | 落点 |
|---|---|---|---|
| **hook-engineer 钩子工程** | 9 类钩子模板枚举 + 开头禁用项(自我介绍式/缓慢运镜判废) + Galloway 开场三步(兑现点击→制造好奇→无缝流) + dead-sentence 黑名单 + 一脚本多 Hook 版本(支持 Dou+ A/B) | 蝉妈妈/CSDN 钩值触模型;Paddy Galloway | content-planning 新模块 + 评审 checklist |
| **script-structure 口播脚本时间轴** | 60s 五段式(0-3 Hook→3-15 痛点→15-45 干货≤3点→45-55 金句→55-60 CTA)、每句≤12-20字、每5s一信息点;SCQA/金字塔/故事+干货结构选择器;Blackman TTS 钩子 + STP 正文 | 国内口播套路 + GitHub douyin-script 开源实现 + George Blackman | content-planning 新模块 |
| **audio-spec 声音设计规范** | 平台 LUFS 表(抖音系 -16 LUFS/-1dBTP)、人声锚点 -6~-12dB、SFX -12~-18dB、音乐 -18~-24dB、ducking 3-6dB、四轨分离;ffmpeg loudnorm/ebur128 程序化检测 | 行业混音标准(PureAudioInsight/Krotos 等) | content-assembly 新模块 + 质量门禁扩展。**注意:目前音效(SFX)体系完全缺失,只有 BGM** |
| **retention-review 留存评审卡** | MrBeast 三指标(CTR/AVD/AVP)、15秒 payoff 死线、前30秒留存>75% 基准、掉点位置→病因映射表;国内三率阈值(标注经验值、参数化) | MrBeast 泄露手册 + Prepublish + 蝉妈妈 | content-evaluator criteria 各阶段扩充 |

### P1(第二批,建立差异化壁垒)

| Skill | 内容 | 落点 |
|---|---|---|
| **packaging-first 包装先行** | 选题确认后先产标题+封面概念再分镜("packaging IS the product");标题四式(悬念/痛点/数字/对比)+封面承诺一致性校验 | trend-research→plan 流程改造 |
| **asset-prompt-compiler 素材 prompt 编译器** | Kling/Pika/Runway 五槽公式(主体/动作/场景/镜头/光影)收敛为统一中间表示;单运动约束、static 显式声明、负面词库、60-100词有效长度 | asset-generation 新模块,对接 H3/即梦/Seedance 多 provider |
| **storyboard-grammar 分镜语法** | 镜头类型→叙事功能映射(close-up=情绪/长镜=空间)、运镜术语表(dolly/tracking/pan)、180°/30°规则(轻量适配 AI 单镜头生成) | content-planning 模块 |
| **选题评分卡 + 对标拆解** | 五要素公式(大基数×强痛点×高差异×浓情绪×准适配)+三无否决项;Galloway outlier 研究法(每周4h跨赛道拆解) | trend-research 增强 |
| **财经信源与合规红线** | 数据必带出处+日期;不承诺收益/不荐股等红线(公开资料无人覆盖,需自建)——财经账号的生存线 | 横切约束,注入各阶段 |

### P2(第三批,运营闭环)

| Skill | 内容 |
|---|---|
| **caption-qc 字幕规范** | Netflix TTSG 适配:42字符/2行/17CPS/语义断行,全程序化校验进质量门禁 |
| **color-director 色彩脚本** | 情绪→调色板映射、teal-orange 参数、策划期 color script 模板(升级现有 color-grading 模块) |
| **爆款裂变器/栏目化** | 一条爆款→3-5 同构选题;账号内容配比(7:2:1)日历 |
| **评论区预埋设计** | 结尾开放问题+4类预埋评论文案生成 |
| **数据回流评估表** | 发布后三率阈值判定→优化建议路由(阈值全部可配置) |

### 工程修复(非 skill,但必须先做)

1. **模块加载调度**: ws-bridge 按作品内容类型(genre)+当前阶段强制列出应读模块清单(如财经口播=industry → 必读 visual-aesthetics + color-grading + audio-spec),不再"按需阅读"
2. **双 prompt 源同步**: ws-bridge 与 api.ts 的规则单源化(今日 BGM 规则已出现一次不一致)

## 四、两个重要警告

1. **阈值参数化**: 调研中所有百分比阈值(完播率40%、3秒跳出65%、回复率80%)均来自经验帖,skill 中必须做成可配置参数并标注来源性质,禁止硬编码为"平台规则"。
2. **YouTube 规则需抖音化适配**: 国际留存工程(MrBeast/Galloway)以长视频为语境,pattern interrupt 60-90s 的间隔在 60s 短视频里要改为 5-10s;使用时做尺度换算。

## 五、与首片实证的对照

首片(w_20260814_1335_4ff)暴露的问题与本报告的映射:
- "整体 low 不高大上" → 缺 audio-spec(SFX 层)+ color-director(调色意图)+ 模块未加载
- Hook 中等强度 → 缺 hook-engineer(9 类模板选择+多版本)
- 图表口径/抖动 → 已由今日修复覆盖(铁律+防抖红线)
- 数字人误用/BGM 压人声 → 已修复,但印证"规则单源化"的必要性

## 六、参考开源资产

- github.com/ravsau/youtuber-skills — 12 个 YouTube 策划 skills(MrBeast/Galloway/Blackman 方法论),可借鉴结构
- github.com/5tldr/claude-skills/skills/douyin-script — 抖音口播脚本 skill 开源实现
- github.com/AgriciDaniel/claude-youtube — 14 个 YouTube 子技能
- Remotion Agent Skills(remotion-dev/skills) — 程序化视频合成执行层(若未来走代码渲染路线)
