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

## 批次 2:规则速修与 autoMode 出口 【⬜】

论证依据:v3 附录 M19。纪律:criteria 合并方向 homedir→仓库先回填;同步只管理项目 5 个 skill 子目录。

- [ ] 2.1 criteria 合一:homedir assembly.md 维度 7 回填仓库 → 运行时改读仓库副本
- [ ] 2.2 同步机制修复:index.ts rsync → Node copyDir(禁 --delete 语义)
- [ ] 2.3 同消息互斥对速修:py -3 统一 / 禁 AI 改"用户未显式选 AI 时" / autoMode 下"3 选 1"改自行拍板
- [ ] 2.4 音量口径收敛:loudnorm 胜,SKILL.md volume% 旧规退休;MarginV 430 统一;字体 macOS 残留删除
- [ ] 2.5 死 API/PUT 旁路:trend-research:273 死 API 删除;content-planning:369 改 advance;PUT 端点拒绝 pipeline 字段写入
- [ ] 2.6 autoMode 合法出口:注册 AskUserQuestion + scheduleAutoContinue 加 awaiting_user 抑制 + 提问超时兜底(N 分钟最小降质自动继续)

## 批次 3:research 确定性与护栏改造 【⬜】

- [ ] 3.1 research 阶段确定性契约(api.ts:2139-2168 改步骤清单:搜索通道路由表/查询词模板/失败改写规则/信源 URL 必填)
- [ ] 3.2 curl 精确拦截:bashBlocklist 配置"含 curl|wget 且含 http 且不含 localhost|127.0.0.1 → 拒绝+指路 $web_search"(纪律:内部 curl 占 70-90%,严禁一刀切)
- [ ] 3.3 kimi 不可用降级路由:本地 trends 数据+记忆搜索+显式声明"本次无联网",禁止退化自由 curl
- [ ] 3.4 M13.3 杀改拦:同参第 2 次起软拦截+换路提示;拦后还试 ≥3 次才杀回合;命令签名归一化
- [ ] 3.5 自我赦免修复:被杀回合不计"有进展";进展判定改作品目录实质写入(排除 chat.jsonl)

## 批次 4:可观测性与诚实状态 【⬜】

顺序纪律:bash 心跳 → 活性阈值收紧 → beat 协议 → 假状态文案。beat 绝不更新 lastActivityAt。

- [ ] 4.1 bash 心跳:ToolContext 加 onProgress,LoopEvent 加 tool_progress,stdout 周期 tail 广播
- [ ] 4.2 活性判定:loopState=running + lastActivityAt >12-15min 判挂死;evalLoopRunning+evalStartedAt>15min 判死
- [ ] 4.3 渲染/轮询接事件:renderer onProgress 广播;生视频轮询事件;配额冷却事件
- [ ] 4.4 beat 协议:15s session_beat;前端以 beat 判活,废 60s 启发式
- [ ] 4.5 假状态修复:"停滞·自动恢复中"只在恢复机制真实存在时显示
- [ ] 4.6 全局通知中心雏形:eval_blocked/配额冷却/作品失败全局可见

## 批次 5:v2 P0 三件套 【⬜】

- [ ] 5.1 M0① 幻觉闸:trend-research.ts collectOne,raw===""+无 builtinSearchTool → error 不入库
- [ ] 5.2 M0③ duration 统一:quality-gate 导出 MAX_PLAN_DURATION_S=180,api.ts:3634 clamp+log,prompt 常量生成
- [ ] 5.3 M0④ 落库即失败:api.ts:3717 catch 里 throw
- [ ] 5.4 M0⑤ topN 前置:数量要求 ceil(topN×1.5/平台数),下限 5;采集互斥锁
- [ ] 5.5 M0⑥ scriptModel 假开关删除
- [ ] 5.6 M0② batch research 轻量抽查:runJsonPrompt 数据真实性抽查,不过则 item error
- [ ] 5.7 M2①③ material-search/assets 机器门禁(同构函数+分支)+ 模版预览黑屏拦截(blackdetect 挂 code-template-generator.ts:195)
- [ ] 5.8 M1①② explicitParams 数据链:POST /api/works 收参数 → works 表加 explicit_params 列(migration)→ 创作 prompt"用户显式要求(最高优先级)"段 → buildEvalPrompt 豁免清单

## 批次 6:criteria 二分与图文门禁、M3 小项 【⬜】

- [ ] 6.1 M1③ criteria 硬性/最佳实践二分(5 文件人工标注)
- [ ] 6.2 M2② 图文等价门禁双路径(纯图文 assembly + deriveDualOutputs 派生)
- [ ] 6.3 M3 eco 门禁:api.ts:918 读 asset_budget 拒绝云端 + 同批修 ws-bridge.ts:290 矛盾指令 + assertH3Ready 接线
- [ ] 6.4 M3 H3 四处 fetch 超时 + 半开检测(checkH3Health 复用)+ 重复提交防护
- [ ] 6.5 M3 数字人 GET /jobs/:id 内联 refreshJob
- [ ] 6.6 M3 回合软着陆:到期前 5min 注入收尾指令

## 批次 7:评审软化与失败通道 【⬜】

前置:批次 1(eval_blocked 封堵)、批次 2(criteria 合一)、批次 4(活性判定)。

- [ ] 7.1 M5 熔断软化:minor-only → awaiting_human 状态 + UI 人工放行/指导重试按钮
- [ ] 7.2 M5 重复问题提示(与 M13.1 同一实现,buildFeedbackPrompt,Jaccard 相似度 ≥0.6)
- [ ] 7.3 M5 图文 criteria 分文件(criteria/${work.type}/${step}.md 优先,step-contract 自检侧同改)
- [ ] 7.4 M5 按阶段降档:eval:research/eval:plan 档(先实测 glm-5.3-flash 成本与指令服从)
- [ ] 7.5 M6 failVisible 助手 + 20+ 静默失败站点逐点替换
- [ ] 7.6 M6 发布安全两修:publish-service.ts:159 + publishing.ts:151 两处超时取消底层;publishing.ts:127 禁重发
- [ ] 7.7 M6 内存态对账:batchConvertJobs 重启由 topic.status 反推
- [ ] 7.8 M6 watchdog 扩展:reviewing/渲染池/发布/publish_records 维度

## 批次 8:模版契约与台账遥测 【⬜】

- [ ] 8.1 M4 code 模版 refine TSX 专用通道(校验链复用 code-template-generator)
- [ ] 8.2 M4 绑定模式显式化 + code-scene 设计令牌注入(themes.ts 扩展;footage 级皮肤单列不做)
- [ ] 8.3 M4 媒体槽硬失败 + req.assets 接入 code 模版渲染(video-factory.ts:258-311 断线修复)
- [ ] 8.4 M4 template_fidelity 视觉比对(brief 持久化 + chatVisionJson 抽帧比对 + 阈值拒收)
- [ ] 8.5 M2④+M4 元数据-能力一致性白名单(layout/decorations/code params 常量导出+入库静态校验)
- [ ] 8.6 M7 成本台账:内置默认价目+未知模型 warn(与 8.7 同一次迁移)
- [ ] 8.7 M7 遥测:llm_usage 加 latency_ms + thinking_tokens(合并一次 migration)+ 阶段墙钟报表

## 批次 9:M9 真独立项与作业化 【⬜】

- [ ] 9.1 DH-3 GPU 任务取消核实 + H3-2 提交幂等 + H3-5 GPU 互斥锁
- [ ] 9.2 P-4 两套发布栈合并(需无在投任务窗口)
- [ ] 9.3 A-2 cron 重入锁 + A-3 采集资源互斥
- [ ] 9.4 双产物 3.3 风格漂移 + 3.4 图卡配对
- [ ] 9.5 M3 长任务作业化(whisper 接入点,照抄 render-jobs 模式)

## 批次 10:极速模式与二三梯队 【⬜,动工前补论证】

- [ ] 10.1 M8 code-scene warm 池(Revideo 内部 API 耦合风险)
- [ ] 10.2 M8 镜头并行(依赖 9.5 作业化)+ 评审分级 standard|express
- [ ] 10.3 M14 学习回路 / M17 介入通道 / M18 无超时清零+额度记账+磁盘清理
- [ ] 10.4 M11 沉淀闭环 / M12 上下文经济学(thinking 回填瘦身/阶段边界 compact/cache 命中)

## 已完成的模型选项任务(2026-08-28,独立于批次)

- [x] 设置页新增 glm-5.3-flash 与 deepseek-v4-flash-vision-exp(4 文件,已暂存待 commit)
