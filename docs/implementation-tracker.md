# AutoViral 系统性优化实施追踪表

> 创建于 2026-08-28。方案来源:docs/2026-08-27-systemic-optimization-plan.md(v2)+
> docs/2026-08-28-agent-behavior-economics-v3.md(v3,含全部可行性论证)。
> 状态标记:⬜ 未开始 / 🔵 进行中 / ✅ 完成 / ⏸️ 阻塞(注明阻塞原因)
> 每批次完成后:跑构建(tsc+vite)+ 相关测试,commit,更新本表与记忆。

## 批次 1:评审器超时与熔断闭环 【✅ 完成 2026-08-28】

论证依据:v3 附录 M15/M16(SSE)论证结论。互为前置,同批做。
验证:tsc + vite + 全量 143 文件/1058 测试通过;evaluator 测试按新语义更新。

- [x] 1.1 SSE 停滞超时(openai-compat.ts)
  - 分段计时:首 delta 180s / 流中停滞 120s
  - 已守纪律:显式 throw StallTimeoutError;独立 AbortController + AbortSignal.any;
    普通 Error 由 retry.ts 接管;顺带修复 abort 后空转 3 次退避的旧缺陷(noRetry 化)
- [x] 1.2 评审器硬超时(evaluator.ts runApiEvaluator)
  - 15min 硬超时(guard.evalTimeoutMinutes 可配)→ abortTurn + 抛 EvalTimeoutError
  - session.evalStartedAt 供 watchdog 使用(evalStep 只写不读的死字段升级)
- [x] 1.3 超时降级链(api.ts runEvaluation catch)
  - 超时 → 10s 后同模型重试 → 换模型(pickFallbackEvalModel)→ plan/assembly 机器门禁
    兜底(gateFallback 合成评审结果,pass 带 __gateOnly 标记,flow 复用正常 PASS/FAIL 分支)
    → eval_blocked 交人工(markEvalBlocked 抽取共用)
  - 超时计数持久化为作品目录 eval-timeout-{step}-N.json 标记文件(可审计、不烧 eval_attempts)
- [x] 1.4 eval_blocked 复活封堵(api.ts 守卫1c)
  - advance 拦截 completedStep 自身 eval_blocked,409 拒绝;只允许人工通道重开
- [x] 1.5 __parseFailed 兜底改 fail(evaluator.ts)
  - 二次解析失败 → 抛 EvalParseError 进 eval_error 链;旧测试语义同步更新

## 批次 2:规则速修与 autoMode 出口 【✅ 完成 2026-08-28】

论证依据:v3 附录 M19。纪律:criteria 合并方向 homedir→仓库先回填;同步只管理项目 5 个 skill 子目录。
验证:tsc + vite + 全量 1058 测试通过(2 个旧测试按 PUT 新契约更新)。

- [x] 2.1 criteria 合一:homedir assembly.md 维度 7(模板还原度)已回填仓库;
  运行时改读仓库副本(step-contract.ts CRITERIA_DIR + api.ts buildEvalPrompt,PROJECT_ROOT 上溯解析)
- [x] 2.2 同步机制修复:index.ts rsync → Node syncSkillsDir(只增改不删除,保护 yaml/permitted_skills.md;
  修掉 Windows 无 rsync 每次启动静默失败 + --delete 误删用户 50+ 个人 skill 的双重隐患)
- [x] 2.3 同消息互斥对速修:python3→py -3 统一(ws-bridge 4 处+api.ts runTrendScript 平台化+api.ts 2 处);
  assets 素材库优先段对 assetSource=ai 跳过(禁 AI 互斥消除);
  autoMode 下"提 1-2 个问题/3 选 1/对话确认方向"全部改自行拍板(api.ts 1999/2004/2007/2138/2168)
- [x] 2.4 音量口径收敛:loudnorm 胜(SKILL.md:136/493/500/505-507 改写,volume% 旧规废除);
  MarginV 430 统一(pro-captions.md 抖音行);字体三套合一到 NotoSansCJKsc
  (asset-generation macOS 残留改 $HOME 路径;api.ts 2456/2468/5424 封面字卡同源)
- [x] 2.5 死 API/PUT 旁路:trend-research:273 死 API、content-planning:369、asset-generation:1377、
  content-assembly:896 四处全部改 advance;**PUT /api/works/:id 机制性封堵**(pipeline/status 直写 403)
- [x] 2.6 autoMode 合法出口:AskUserQuestion 注册(tools/ask-user.ts)+ scheduleAutoContinue
   awaiting_user 抑制(论证新发现 #4 修复)+ 10min 无人答超时兜底(最小降质+显式声明自动继续)
  + autoMode prompt 白名单句(中英文两处)

## 批次 3:research 确定性与护栏改造 【✅ 完成 2026-08-28】

验证:tsc + 全量 1058 测试通过(code-scene 渲染测试全量并行下偶发 195s 超时,单跑 20/20 通过,环境性 flake 与本次改动无关)。

- [x] 3.1 research 确定性契约:step-contract.ts 新增 SEARCH_PROTOCOL(唯一通道 $web_search/查询词
  构造/失败改写顺序/信源 URL 硬要求/降级路由),research 两分支统一注入;"WebSearch" 伪工具名
  正名为 $web_search(api.ts 4 处,05d 曾把它当 bash 命令敲)
- [x] 3.2 curl 精确拦截(bash.ts):含 curl|wget 且含外网 http(s) URL → 拦截+四类换路指引;
  localhost/127.0.0.1 白名单(内部 API 占 70-90%,未误伤);yt-dlp 不受影响
- [x] 3.3 kimi 不可用降级:SEARCH_PROTOCOL 第 5 条(本地 /api/trends/:platform + 显式声明
  "本次无联网",禁止退化为抓站);代码层自动检测留待 M18
- [x] 3.4 杀改拦(loop.ts):同参第 2/3 次软拦截+换路提示,第 4 次才杀回合;
  Bash 命令签名空白归一化(防微调逃逸)
- [x] 3.5 自我赦免修复(ws-bridge):被杀回合历史增长不再算"有进展";进展判定升级
  为作品目录实质写入快照(workProgressStamp,排除 chat.jsonl/eval-*.json 系统自写)

## 批次 4:可观测性与诚实状态 【✅ 完成 2026-08-28】

顺序纪律已守:bash 心跳 → 活性阈值收紧 → beat → 假状态文案。beat 未触碰 lastActivityAt。
验证:tsc + vite + 全量 1058 测试通过。

- [x] 4.1 bash 心跳:ToolContext.onProgress + LoopEvent tool_progress + bash 每 12s 回传输出尾部;
  ws-compat 广播不落 chat.jsonl;Studio 心跳续命活性指示器
- [x] 4.2 活性判定修复("挂死=永活"悖论):loopState=running 需 12min 活性窗
  (bash 心跳续活动,正常长命令不误杀);evalLoopRunning 需 16min 窗(评审硬超时 15min 主防线外兜底)
- [x] 4.3 渲染/轮询接事件:progress-events.ts 总线(services 层免 import 环);
  成片渲染进度广播(video-factory);即梦/Seedance 轮询逐次透出(jimeng 4 处+seedance 1 处)
- [x] 4.4 beat 协议:ws-bridge 15s session_beat(只读状态快照);Studio 以 beat 判活,
  60s 启发式被心跳接管
- [x] 4.5 假状态修复:"停滞·自动恢复中"仅当队列项 running(看门狗确实接管)时显示,
  否则如实显示"停滞·需人工查看"
- [x] 4.6 全局通知中心雏形:/ws 全局通道 + broadcastGlobal;eval_blocked 与配额冷却接入;
  App.svelte toast 堆栈(12s 自动消失)

## 批次 5:v2 P0 三件套 【✅ 完成 2026-08-28】

验证:tsc + vite + 全量 1058 测试通过。关键设计修正:用户显式 duration **不落 clamp**
(M1 宪法优先于平台默认口径)——门禁与评审以显式值为上限,仅预设默认才 clamp。

- [x] 5.1 M0① 幻觉闸:trend-research.ts collectOne,raw==="" 且无 builtinSearchTool →
  平台 error 透出,不入库(宁缺毋假)
- [x] 5.2 M0③ duration 统一:MAX_PLAN_DURATION_S=180 单一事实源(quality-gate 导出,
  ws-bridge prompt/api.ts 引用);batch 入口预设默认 clamp+日志
- [x] 5.3 M0④ 落库即失败:api.ts catch 里 throw,接入 processItem 重试/终态机制
- [x] 5.4 M0⑤ topN 前置:每平台目标 ceil(topN×1.5/平台数) 下限 5;采集互斥锁
  (collectRunning,定时/手动互斥)
- [x] 5.5 M0⑥ scriptModel 假开关删除:config.ts 字段+默认值、api.ts 读取传参、
  content-generator 4 处透传全清
- [x] 5.6 M0② batch research 轻量抽查:runJsonPrompt(eval 档)真实性三规则判定,
  不过则 item error 不推进;抽查通道故障不阻塞但留痕
- [x] 5.7 M2①③ material-search/assets 机器门禁(advance 挂接,与 plan/assembly 同构)
  + 模版预览黑屏拦截(blackSegments 挂 code-template-generator 修复循环,2 轮仍黑不生成)
- [x] 5.8 M1①② explicitParams 数据链:POST /api/works 收 duration → works.explicit_params
  (migration v30)→ 创作/评审 prompt 共用 buildExplicitParamsBlock(最高优先级豁免)→
  plan 门禁 assertPlanDeliverables(workDir, explicitDuration) 豁免

## 批次 6:criteria 二分与图文门禁、M3 小项 【✅ 完成 2026-08-28】

前置:批次 1/2 已落地。验证:tsc + vite + 全量测试 1057/1058(唯一失败为已知
code-scene 渲染 flake,单跑 20/20 通过)。

- [x] 6.1 criteria 硬性/软性二分:5 文件全部加分级约定头(优先级宪法写入:显式参数>硬性>软性
  >自由裁量)+ 全部维度打标;顺手修 assembly.md 字幕字数残留矛盾(15-20 vs ≤15)
- [x] 6.2 图文等价门禁双路径:①纯图文 assembly advance 挂 assertImageTextDeliverables
  (卡片≥2/封面/空白文件)②双产物派生失败显式化(dual-output-failed.txt 标记+总线广播),
  空图文不再静默过审
- [x] 6.3 eco 门禁:/api/generate/video 读 asset_budget,eco 档云端 provider 403
  (ECO_BUDGET_BLOCKED);ws-bridge H3 离线声明按 budget 分支(eco→阻塞文案,与
  step-contract 对齐);assertH3Ready 接线到 eco+local-h3 路径(503 提前显式失败)
- [x] 6.4 H3 四处 fetch 超时(h3Fetch 30s/60s/15s 分档)+ 超时后 checkH3Health 半开检测;
  顺手修 _volcengine-cv 提交/查询/下载三处无超时(30s/15s/120s)
- [x] 6.5 数字人 GET /api/digital-humans/jobs/:id 内联 refreshJob(running/pending 时),
  "轮询不刷新的端点"修复
- [x] 6.6 回合软着陆:到期前 5min 注入收尾指令(半成品落盘+断点说明+禁开新长任务)

## 批次 7:评审软化与失败通道 【✅ 完成 2026-08-28】

前置(批次 1/2/4)均已落地。验证:tsc + vite + 全量测试(3 个超时型 flake 单跑 50/50 通过;
publish-account 2 个测试按"禁重发"新契约更新)。

- [x] 7.1 M5 熔断软化:剩余问题全 minor → awaiting_human 新状态(不杀作品),
  含 critical/major 维持硬熔断;force-pass/retry 白名单接纳;Works/PipelineSteps/Studio 全呈现
- [x] 7.2 M5 重复问题提示(与 M13.1 同一实现):buildFeedbackPrompt 跨轮 bigram Jaccard ≥0.6
  比对,命中附"换路警示+备选策略表"(素材不符→换源不换描述等)
- [x] 7.3 M5 图文 criteria 分文件:criteria/image-text/plan.md+assembly.md 新建
  (不再要求 final.mp4);readCriteriaForStep/readCriteriaPathForStep 双挂点(创作自检+评审)
- [x] 7.4 M5 按阶段降档:config.llm.evalLightModel("provider:model"),research/plan/material-search
  评审可降档,assets/assembly 必须看图不受影响
- [x] 7.5 M6 failVisible 助手(services/fail-visible.ts)+ 关键站点:batch job 崩溃标 error
  (不再标 done);DH-1 数字人轮询超时回写 DB failed+通知
- [x] 7.6 M6 发布安全:PublishInput 加 AbortSignal,两处超时护栏(publish-service:159 +
  publishing.ts:151)超时即 abort 底层;已 published/reviewing 记录禁重发(403 语义)
- [x] 7.7 M6 batchConvertJobs 重启反推(轻量):404 文案说明影响面与自查路径;
  A-1 评论 externalCommentId 合成稳定哈希键(去重生效)
- [x] 7.8 M6 watchdog 扩展:reviewing 滞留 24h/数字人 running 30min/发布 publishing 15min
  三维告警(去重防刷屏);A-4 登录态失效垃圾指标拒入库+通知(账号与作品两级)

## 批次 8:模版契约与台账遥测 【✅ 完成 2026-08-28】

验证:tsc + vite + 全量 1058/1058 通过。范围纪律:v2 低估的"全片皮肤"切两刀——
本批只做 code-scene 令牌注入;footage 级皮肤(调色/转场覆盖真人素材)确认超范围,不做。

- [x] 8.1 M4 code 模版 refine TSX 专用通道(template-refine.ts refineCodeTemplate:
  完整 TSX → staticCheckTsx → 试渲染 → 黑屏拦截,2 轮不过报错;覆盖写回降回 candidate)
- [x] 8.2 M4 令牌注入最小切片:themes.ts ThemeTokenOverrides + getSceneTheme(key, overrides)
  全 8 场景接入;layers[0].designTokens → params.themeTokens(video-factory 接线)
- [x] 8.3 M4 媒体槽硬失败 + req.assets 断线修复:renderCodeTemplate 接 assets/variables,
  媒体槽(type:video/image)无值即硬失败(假窗口制度性封堵)
- [x] 8.4 M4 template_fidelity:brief/style 随 layers[0] 持久化(免 migration);
  生成入库前抽帧×2 + chatVisionJson 视觉比对设计意图,score<6 进修复循环;
  视觉通道不可用放行并 warn(不成单点故障)
- [x] 8.5 M2④+M4 元数据-能力一致性:RENDERER_DECORATIONS 白名单(accent_bar/serial_number/
  divider/corner_marks),图文模版创建端点+生成器入库双挂点;layout 不硬拦(渲染端有兜底,
  存量 big_title_center 等不受影响——首版误拦已修正)
- [x] 8.6 M7 成本台账:内置默认刊例价 7 模型(用户 priceTable 优先覆盖)+ 未知模型 warn
  (不再静默归零)——cost 恒 0 根因(纯缺配)修复,日预算熔断恢复实效
- [x] 8.7 M7 遥测:migration v31 llm_usage +latency_ms/+thinking_tokens;流式/非流式/vision
  全链埋点;GET /api/works/:id/timing 阶段墙钟+token+成本报表端点

## 批次 9:M9 真独立项与作业化 【✅ 完成 2026-08-28(P-4 有 conscious 延期)】

验证:tsc + vite + 全量测试(仅剩 2 个已知负载型 flake,单跑全过)。
**P-4 两套发布栈合并:⏸️ 延期**——论证估值 400-600 行+数据迁移+在投窗口要求,
风险最高项,不应在无实测的连续批次中落地;待整体实测后择窗口单做。

- [x] 9.1 DH-3:heygem cancelJob best-effort(DELETE,官方支持未证实,失败静默)+ 超时时调用;
  H3-2:local-h3 (workId,filename) 在途任务表,重复提交复用同一 Promise;
  H3-5:gpu-lock.ts 进程内互斥(H3 生成持锁 / HeyGem pollJob 轮询期持锁,finally 释放;
  测试友好的粒度重构——submit 不持锁,持锁点在有生命周期控制的位置)
- [x] 9.3 A-2 cron 重入防护:analytics-scheduler 账号/作品两轮各加 running 标志
  (A-3 采集资源互斥依赖 M7 调度框架,M7 并行化已论证降级——记为不做)
- [x] 9.4 双产物配对核查:素材图→卡片已是确定性配对(文件名排序+取模),
  "随机配对"实证不成立;语义级配对(视觉模型)列入批次 10 评估。3.3 风格漂移同理(需视觉机制,延期)
- [x] 9.5 M3 长任务作业化:migration v32 long_tasks 表 + services/long-tasks.ts(ASR 首接入点,
  spawn 后台+日志落盘+30s 心跳广播)+ POST/GET /api/long-tasks + ws-bridge 长任务铁律改写
  (ASR 优先走作业化 API,不占回合/bash 上限)

## 批次 10:极速模式与二三梯队安全切片 【✅ 完成 2026-08-28(部分项留实测基线)】

验证:tsc + vite + 全量 1058/1058 通过。

- [x] 10.2 M8 评审分级:migration v33 works.eval_mode(standard|express);express =
  机器门禁照跑 + 仅 assembly 单轮 LLM 终审,其余阶段门禁过后直接推进;
  batch 弹窗/单作品创建 API 均可指定;UI 选择器已于 2026-08-31 实测准备时接通
  (NewWorkModal 评审模式 chip + Topics 批量弹窗 select,默认 standard)
- [x] 10.3 M18 无超时清零:minimax tts/music/voice-clone×3、nanobanana、stock 下载、
  asset-library、memory.ts、template-clone×2、login-health×3、5 家官方发布商主链路
  (发布商多行异形 fetch 有少量残留未覆盖,务实收尾);M14 事故卡(services/incidents.ts,
  熔断时写卡+会话启动注入最近 3 张教训摘要,消灭换皮重跑);M17 决策事件化首项
  (成片时长渲染确定即广播)
- [ ] 10.1 M8 code-scene warm 池(Revideo 内部 API 耦合风险)——**留待实测基线后单做**
- [ ] 10.2 补充:M8 镜头并行(依赖 9.5 已就绪,可后续开)+ kimi 显式缓存(M12.4 数据先行)
- [ ] 10.3 剩余:M11 沉淀闭环 / M12 思考回填瘦身+阶段隔离 / M18 额度记账与磁盘清理——
  均需批次 1-10 实测数据支撑后启动(v3 附录纪律:二三梯队动工前补论证)

## 已完成的模型选项任务(2026-08-28,独立于批次)

- [x] 设置页新增 glm-5.3-flash 与 deepseek-v4-flash-vision-exp(commit 4f5142f)

## 实测前准备(2026-08-31)

- [x] code-scene 运行时产物移出 git:packages/code-scene/.gitignore 新增
  out/、src/generated/、src/custom/current.tsx;git rm --cached 45 个误收文件
  (worker.mjs 渲染时重写,无源码/测试依赖,安全)
- [x] express 评审模式 UI 接通:NewWorkModal 加"评审模式"chip(i18n 中英)、
  Topics 批量弹窗加模式 select(仅在质量评审开启时显示),App.svelte/web api.ts 透传 evalMode
