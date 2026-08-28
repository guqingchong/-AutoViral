# AutoViral 生产系统系统性优化方案(v2 全分支版)

> **v3 增补(2026-08-28)见 [2026-08-28-agent-behavior-economics-v3.md](2026-08-28-agent-behavior-economics-v3.md)**:
> 病根 10(隐性流程未固化/Agent 行为经济学)+ M10-M13 新主线。
>
> v2 更新:2026-08-27。v1 的 5 个病根仅覆盖主链路(素材→调研→分镜→素材→合成)。
> 本版基于 4 路并行审计(选题/批量转换、数字人/H3/发布/分析、模版生成/图文、时延结构),
> 新增 70+ 项问题证据(12 项 critical),病根扩展为 9 个,并给出有数据支撑的时间模型。
>
> 审计证据锚点:DB 实证近三作品墙钟 9.1h / 3.7h / 2.1h;单作品 LLM 调用 480-630 次;
> 成本台账 cost 恒为 0;选题管线幻觉趋势可直入生产。

---

## 一、诊断:九层系统性病根

### 病根 1:事实源多头,无优先级仲裁(Rules Chaos)
用户显式参数、用途预设、评审规则、阶段指令、模版元数据五套事实源互相矛盾。
实证:用户选 5 分钟被评审砍到 2:17;authority 预设 300 vs criteria 180(已修);
批量 duration **无上限校验**(api.ts:3634)与 plan 门禁 185s 必然冲突;
素材指令"Pexels 优先"vs 供给现实;**时长口径三头定义**(脚本生成按分钟 floor、
门禁 185s、质量门禁 600s 才 warn)。

### 病根 2:机械校验外包给 LLM(Verification Misallocation)
字数/时长/极限词/剔除素材/0.0万/截断/占位框/yuv444p——每项烧一整轮 LLM 评审(10-30min)。
plan/assembly 门禁已上线;material-search/assets 门禁缺失;**图文作品连等价门禁都没有**
(plan 预检对 image-text 整体跳过,极限词合规缺口)。

### 病根 3:状态机与执行体割裂,无检查点(State/Execution Split)
回合边界=上下文生死线;30min 硬杀长任务;持久化缺口;恢复注入全量 prompt;
孤儿进程挂死;空消息 400 团灭。(昨日已修大半,余:软着陆、长任务作业化未做)
同类未修项:数字人渲染任务超时**永久烂在 running**(digital-human-pipeline.ts:475);
直连提交的渲染任务**无人轮询**,官方指令却让 agent 轮询一个不刷新的端点(api.ts:4176 vs 1861)。

### 病根 4:模版系统契约薄弱(Template Contract Weakness)
绑定模型未定义(全片风格预期 vs 3 卡位现实);参数代码里有元数据没有;
媒体槽留空静默占位;agent 偷换模版评审放行;code-scene 主题与模版脱钩。
审计新增:**code 模版 refine 必然失败**(template-refine.ts:99 按时间线校验 TSX);
refine 覆盖已批准模板不重渲染不降级;图文模版 LayoutSpec.layout 是**渲染端不实现的自由文本**;
**模版预览"可渲染即入库",黑屏无任何拦截**(code-template-generator.ts:195)。

### 病根 5:评审经济学失衡(Eval Economics)
机械与结构同价;熔断一刀切(work2 只剩 1 个 major 被杀);
重复问题不提示换策略(素材改描述式假修 ×4 轮);
**评审解析失败兜底 pass 的放水通道**(evaluator.ts:117);
**图文作品评审标准与视频共用同一套 criteria,图文被要求交付 final.mp4**(幻觉打分根源);
eval 全程用 pro 模型评机械项(高配低用)。

### 病根 6:静默失败是设计模式,不是意外(Silent Failure as Pattern)
全系统 20+ 处错误被吞只记日志:
- batch 落库失败 → **空心作品直接入队**(api.ts:3717)
- batch job 崩溃 → **状态标成 done**(api.ts:3858)
- 双产物派生失败 → **父作品照常 reviewing,无重试入口**(dual-output.ts:836)
- 数字人渲染超时 → **DB 永久 running**(DH-1);**GPU 侧任务从不取消,已付费结果丢失**(DH-3)
- 发布超时标 failed → **底层 Playwright 还在跑,retry 造成重复发帖**(publish-service.ts:159)
- 已 published 记录**可原样重发**(publishing.ts:127)
- 登录态失效 → **垃圾指标照常入库**(douyin-scraper.ts:32)
- 评论采集 externalCommentId 恒 undefined → **去重永不命中+无限分页**(A-1)
watchdog 只盯 4 个状态;reviewing/渲染池/发布/publish_records 全是监控盲区(X-1);
内存态/DB 态双写不一致遍布(batchState/instance state/accountQueues)(X-2)。

### 病根 7:验证只存在于入口,后续路径全部裸奔(Validation Gaps)
模版生成有渲染验证,但 refine/PUT 编辑/brief 确认/双产物派生四条路径零产物级验证;
三处**元数据声明的能力 > 渲染端实际能力**:imageSrc 声明了但渲染白名单不喂值、
LayoutSpec.layout 渲染端只认 center、decorations 无白名单静默丢弃;
生成产物与设计意图之间**没有任何视觉验证闭环**(用户"生成与描述差距大"的结构性根源);
图文子作品先建 reviewing 后渲染卡片,**空图文可被人工审核通过**。

### 病根 8:时延与并发未被当作设计约束(Latency Blindness)
- 单作品 480-630 次 LLM 调用全部串行,中位 7-20s/步 → 50-130min 纯 LLM 时间;
- code-scene 每渲染冷启动 node+vite+Edge,全局串行,无 warm 池;
- **成本台账完全失效:cost_yuan 恒为 0,日预算熔断永不触发**;
- 零延迟遥测:llm_usage 无 latency 列,loop 无计时,系统无法自答"时间花哪了";
- kimi research 阶段缓存为 0(14.7M 输入 tokens 全价);
- TTS/Music/H3 的 fetch 全部无超时(H3 隧道半开=无限挂起);
- 选题管线:强制每平台≥15 选题(7 平台≥105 个)然后 topN=10 截断,**90% 生成直接丢弃,每天两次**。

### 病根 9:关键路径靠"prompt 自觉",无代码护栏(Prompt-Only Enforcement)
- eco 成本管控纯文本约定,`/api/generate/video` 不读作品 budget,任意 provider 任意调;
  且两处注入指令互相矛盾(eco 禁云端 vs "H3 离线用即梦替代");
- `waitH3Ready/assertH3Ready` 阻塞原语**写了从未接线**;
- H3 降级声明是会话启动一次性快照,中途上下线不改口;
- agent 无时间/成本预算概念:过度验证(OCR 逐卡、medium whisper ×3)无停止规则;
- X-3 模式:H3 阻塞/数字人轮询/缺口声明全靠 prompt 文本约束,agent 一次"提前收工"即死局。

### 病根 0(源头):选题管线质量无闸(Source Quality)
- **幻觉趋势选题**:采集失败退化为无搜索 LLM,凭先验编造"最新趋势"照常入库;
  batch 路径 research 直接标 done **永不评审**,幻觉选题直进生产烧全链路成本;
- 热搜原始数据截断 3000 字符;定时与手动采集无互斥(重复选题+双倍烧钱);
- 中文标题近似去重基本失效;任务 job 全部内存态,重启即丢;
- `config.scriptModel` 是死配置(实际走 llm.models.script 档),调它不生效;
- 单转路由先建作品后生成,LLM 失败留孤儿作品;重复转换无 topic.status 防护。

---

## 二、时间模型:9 小时能降到多少?(数据回答)

| 场景 | 墙钟 | 构成 |
|---|---|---|
| work1 实际(2026-08-26) | 9h08m | 故障连环+9 轮评审+串行排队 3h |
| 历史最佳(含评审,无大故障) | 2.1h | w_20260814 实证 |
| 无评审模式实证 | 42min | w_20260717(0 轮评审) |
| **全部病根修复后的现实地板** | **90-120min** | LLM 400+步(50-130min)+评审 4 轮(20-40min)+媒体刚性(15-25min) |
| 硬地板(纯素材库+全一轮过) | 60-75min | 媒体生成物理下限 |
| **极速模式(见 M8)** | **30-45min** | 机器门禁+单轮终审+渲染 warm 池+镜头并行 |

**结论:30-60min 在保留完整 LLM 评审体系下物理上不可能(LLM 串行步即 50-130min)。
可达承诺:标准模式 ≤90min(6 倍提升);极速模式 30-45min(机器门禁+1 轮 LLM 终审)。**

---

## 三、重构方案:十条主线

### M0 源头治理:选题管线质量闸 【P0】
1. 采集失败且无搜索能力时**禁止产出选题**(幻觉闸):标记 degraded,不入库或入"待人工"池;
2. batch 路径 research 标 done 前强制过 research 评审(或至少数据真实性抽查);
3. duration 上限校验(与 plan 门禁同一常量,单一事实源);时长口径三头统一;
4. 落库失败即失败(禁止空心作品入队);job 崩溃标 error 不标 done;topic.status 重复转换防护;
5. topN 前置:按 topN×1.5 生成,不再 105 选 10;job 状态落库(重启可恢复);
6. 修 scriptModel 死配置:统一到 llm.models.script 或删除该配置项。

### M1 事实源优先级宪法 【P0】
用户显式参数 > 预设默认 > 评审通用规则 > agent 自由裁量。
explicitParams 标记;评审 prompt 注入豁免清单;criteria 规则二分[硬性]/[最佳实践];
预设-criteria 一致性单测。

### M2 确定性校验层全覆盖 【P0】
- material-search/assets 机器门禁(与 plan/assembly 同构):schema/抽帧占位/时长匹配/OCR 抽验;
- **图文作品等价门禁**(卡片数/封面存在/极限词),废除"整体跳过";
- **模版生成产物验证**:预览黑屏拦截(blackdetect+纯色率)+视觉模型抽帧比对设计意图,
  不过不入库;refine/PUT 路径强制重渲染验证,refine 后状态降回 candidate;
- **元数据-能力一致性校验**:variables/LayoutSpec/decorations 声明的能力必须在渲染端有实现,
  无实现路径的声明拒绝入库(三方闭合)。

### M3 执行韧性补完 【P1】
回合软着陆(到期前 5min 预警收尾);长任务作业化(ASR/渲染提交-轮询 API);
数字人轮询端点修复(GET 触发 refresh);H3 全部 fetch 加超时+超时 interrupt 任务+禁止重复提交;
eco 成本管控代码级强制(/api/generate/video 读 budget 拒绝云端);H3 阻塞原语接线。

### M4 模版系统契约化 【P1】
两种绑定模式(全片皮肤/卡位)显式化;模版=设计令牌注入主题系统;
媒体槽留空=渲染失败;template_fidelity 视觉比对;
**修 code 模版 refine 类型错配**(code 走 TSX 专用 refine 通道);
图文模版 LayoutSpec 白名单化(渲染端实现什么就允许声明什么)。

### M5 评审分层与熔断软化 【P1】
机器/LLM/人工三层;熔断软化(minor-only 转人工待决);重复问题策略提示;
**堵评审兜底 pass 放水通道**(解析失败=重评,不是 pass);
**图文评审标准独立**(criteria 按 work.type 分文件);
机械项评审降档(flash 模型),判断项留 pro。

### M6 静默失败治理:统一失败通道 【P1】
**原则:失败必须显式可见,禁止只记日志。**
1. 失败分类上报:用户可见的作品/任务失败必须落状态( failed + reason)并在 UI 可见;
   双产物派生失败给父作品打"图文派生失败"标记+重试按钮;
2. watchdog 扩展到 reviewing/渲染池/发布任务/publish_records,停滞即告警或自动处置;
3. 内存态(batchState/instance state/queue)或落库或重启对账,消灭双写不一致;
4. 发布安全三修:超时先取消底层流程再标态;已 published 禁止重发;两套发布栈合并;
5. 评论采集修 externalCommentId+分页终止条件;登录态失效告警而非垃圾入库。

### M7 调度与可观测性 【P2】
资源类型互斥(ffmpeg/渲染不占 LLM 时放行下一作品);
进度心跳(长工具定期广播,慢与死可区分);
**修成本台账**(priceTable+按模型计价,日预算熔断恢复实效);
延迟遥测(llm_usage 加 latency,阶段墙钟落库——本报告的时间分析应能由系统自产)。

### M8 时延工程:极速模式 【P2】
1. code-scene warm 池(常驻 vite+Edge,渲染即取);
2. LLM 步数瘦身:skills 阅读清单按需加载、工具粒度合并、压缩阈值计 system prompt;
3. AI 生视频镜头并行提交( provider 侧排队,不占 agent 回合);
4. **评审分级**:标准模式(机器门禁+全阶段 LLM 评审,≤90min)/
   极速模式(机器门禁+assembly 单轮 LLM 终审,30-45min),用户创建时可选;
5. kimi 缓存利用/视觉路由成本核算。

### M9 分支还债清单 【P2,按严重度排序逐项修】
数字人:DH-1 running 腐烂/DH-2 无人轮询/DH-3 GPU 任务不取消;
H3:H3-1 无超时/H3-2 重复提交/H3-5 与 heygem 撞 GPU;
发布:P-1 reviewing 转正双断点/P-2 重复发布/P-3 超时误标/P-4 两套栈;
分析:A-1 评论重复入库/A-2 cron 重入/A-3 与生产争资源/A-4 登录态静默;
双产物:3.1 失败不可见/3.2 空图文可过审/3.3 风格漂移/3.4 图卡随机配对;
模版:1.4 数字人预览从未真实验证/1.6 白名单可绕/2.3 refine 无会话上下文。

---

## 四、实施路线图(修订版)

| 阶段 | 内容 | 验收 |
|------|------|------|
| 第 1 周 (P0) | M0 幻觉闸+duration 上限+落库即失败;M1 优先级宪法;M2 material-search/assets 门禁+模版预览黑屏拦截 | 重放 work1/work2:机械问题 0 到达 LLM;5 分钟不被砍;空心作品 0 |
| 第 2 周 (P1) | M3 软着陆+作业化+数字人/H3 轮询修复;M5 评审分层+图文标准独立;M6 失败通道+watchdog 扩展 | 长任务零回合被杀;work2 情形转人工待决;双产物失败可见 |
| 第 3-4 周 (P1-P2) | M4 全片皮肤+refine 通道;M7 调度/台账/遥测;M9 高严重度还债 | 宫崎骏全片风格化;成本/时延系统自答 |
| 第 5 周+ (P2) | M8 warm 池+步数瘦身+极速模式 | 标准模式 ≤90min;极速模式 30-45min |

**回归基线**:work1(9h08m/9 轮评审)、work2(failed)、w_20260819(3.7h/10 轮)为基准用例。
目标:标准模式 ≤90min、LLM 评审 ≤4 轮、机械失分 0、模版视觉一致、失败 0 静默。

---

## 五、已修复项在新架构中的位置

| 主线 | 已落地(2026-08-26) |
|------|---------------------|
| M1 | authority 预设 300→180 |
| M2 | plan 机器预检 |
| M3 | 进程树杀/exit 兜底/timeout 容错/逐回合持久化/空消息清洗/断点指令/pendingEval 死锁修复+8min 兜底 |
| M4 | 模版媒体参数扫描声明、存量模版补登 videoSrc、槽位必填合同 |
| M5-M9 | 未开始 |
