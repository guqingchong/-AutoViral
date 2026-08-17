# AutoViral LLM 直连架构 —— 详细实施方案（施工图级）

> 版本：v2.0 · 2026-08-16
> 状态：待用户批准
> 配套：《01-LLM直连架构-详细设计方案.md》（设计依据/模块细节/风险对策，本文件不重复论证）
> 任务持久化：`feature.json`（同目录，机器可读的任务状态源）
>
> **执行者须知（关键既有事实）**：
> - 现有 CLI spawn 点共 **9 处**（DeepSeek 审查 + grep 验证补全）：`ws-bridge.ts:736`（会话）、`ws-bridge.ts:1114`（评审）、`llm-json.ts:82`（文案脚本）、`template-clone.ts:58`（模板克隆视觉）、`template-research.ts:54`（**模板调研学习**）、`trend-research.ts:277`（**定时趋势调研**，生产路径）、`api.ts:1343` runCliBrief（趋势 fallback，生产路径）、`test-runner.ts:378`、`test-evaluator.ts:220`。`resolveClaudeCommand`（ws-bridge.ts:75）是命令解析器不计入
> - WS 事件契约清单见设计文档 §4.5 映射表；前端消费点在 `Studio.svelte:481-595`、`Explore.svelte:194-267`
> - 可复用件：退避重试 `llm-json.ts:47-68`、JSON 提取 `llm-json.ts:25-38`、防抖保存 `ws-bridge.ts:189-200`、turn 收尾 `ws-bridge.ts:928-975`、评审结果解析 `ws-bridge.ts:1205-1227`、串行锁 `ws-bridge.ts:113-124`
> - works 表/队列表操作参考：`src/db/works-repo.ts`、`src/db/work-queue-repo.ts`
> - **任何任务完成后**：`npm run build` + 相关 vitest + 重启服务验证

---

## Phase 0 —— LLM 基建（2 天）

### Task P0-T1：类型与配置段

**Files:**
- Create: `src/llm/types.ts`
- Modify: `src/config.ts`（L46-98 Config 接口区）

- [ ] **Step 1：写 `src/llm/types.ts`**（类型定义与设计文档 §3.1 逐字一致）

```ts
export type Role = "user" | "assistant";
export interface TextBlock       { type: "text"; text: string }
export interface ThinkingBlock   { type: "thinking"; thinking: string }
export interface ToolUseBlock    { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
export interface ImageBlock      { type: "image"; mediaType: string; base64: string }
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;
export interface AgentMessage { role: Role; content: ContentBlock[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export interface ChatRequest {
  model: string; system: string; messages: AgentMessage[]; tools: ToolDef[];
  maxTokens: number; signal?: AbortSignal;
}
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; block: ToolUseBlock }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number };
export type StageKey = "research" | "plan" | "assets" | "assembly" | "eval" | "script";
export interface LlmProvider {
  readonly name: string;
  readonly protocol: "anthropic" | "openai";
  chatStream(req: ChatRequest, onEvent: (ev: StreamEvent) => void): Promise<{ stopReason: string; assistant: AgentMessage }>;
  chatJson<T>(prompt: string, opts: { model: string; timeoutMs?: number; maxAttempts?: number }): Promise<T>;
}
```

- [ ] **Step 2：`src/config.ts` 加 LlmConfig**（接口与设计文档 §3.6 一致；`Config` 加 `llm?: LlmConfig`；`getDefaultConfig()` 不落 llm 字段——未配置时一切维持现状）
- [ ] **Step 3：env 覆盖**：loadConfig 末尾合并 `AUTOVIRAL_LLM_API_KEY`/`AUTOVIRAL_LLM_BASE_URL`（覆盖 defaultProvider 对应字段）
- [ ] **Step 4：`npm run build` 通过；现有测试不红**

### Task P0-T2：OpenAI 兼容 provider（三家）

**Files:**
- Create: `src/llm/openai-compat.ts`
- Create: `src/llm/provider-keys.ts`（三家常量表）

- [ ] **Step 1：`provider-keys.ts`**：

```ts
export const PROVIDER_PRESETS = {
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", visionModel: "deepseek-v4-vision" },
  kimi:     { protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", visionModel: "moonshot-v1-32k-vision-preview" },
  glm:      { protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", visionModel: "glm-4v" },
} as const;
```

- [ ] **Step 2：`OpenAICompatProvider implements LlmProvider`**：
  - `chatStream`：POST `{baseUrl}/chat/completions` `{model, messages, tools, stream:true, max_tokens}`，`Authorization: Bearer`；SSE 逐行解析（`data:` 前缀，`[DONE]` 终止）
  - 消息转换 `toOpenAiMessages(system, messages)`：system→`{role:"system"}`；assistant 的 ToolUseBlock→`tool_calls:[{id,type:"function",function:{name,arguments:JSON.stringify(input)}}]`；ToolResultBlock→`{role:"tool",tool_call_id,content}`；ImageBlock→`{type:"image_url",image_url:{url:"data:...;base64,..."}}`
  - 流式 tool_calls：`delta.tool_calls[i].function.arguments` 字符串分片按 index 累积；`finish_reason==="tool_calls"` 时 JSON.parse 每个累积串，逐个发 `{type:"tool_use"}`；`finish_reason==="stop"`→`message_stop{end_turn}`；`length`→`max_tokens`
  - `usage` chunk（`stream_options:{include_usage:true}`）→ `usage` 事件（含 `prompt_cache_hit_tokens`→cacheReadTokens）
  - reasoning_content delta → `thinking_delta`（GLM）；无则跳过
- [ ] **Step 3：`chatJson`**：非流式调用 + `extractJsonFromText`（import 自 `../services/llm-json.js`）+ withRetry 包装
- [ ] **Step 4：Kimi `$web_search` 接入（Phase 1 交付项，非预留）**：`name==="kimi"` 时 tools 注入 `{"type":"builtin_function","function":{"name":"$web_search"}}`，loop 侧映射为 WebSearch 工具事件；冒烟实测其返回结构并记录 smoke-results.md（research 阶段是流水线第一环，搜索能力不得断档）

### Task P0-T3：重试与路由

**Files:**
- Create: `src/llm/retry.ts`
- Create: `src/llm/registry.ts`

- [ ] **Step 1：`withRetry<T>(fn, {maxAttempts=3, backoffs=[5000,15000,30000]})`**：语义对齐 `llm-json.ts:47-68`；Error 带 `noRetry:true` 直接抛；HTTP 429/5xx 与网络错误重试、4xx noRetry
- [ ] **Step 2：`resolveModelFor(config, stage: StageKey): {provider, model}`**：解析 `llm.models[stage]`（支持 `"kimi:kimi-k2"` 带前缀或裸模型名走 defaultProvider）；provider 未配置/无 apiKey → 抛可读错误（"provider kimi 未配置 apiKey，请在设置页配置"）
- [ ] **Step 3：`getProvider(config, key)`**：懒构造 + 缓存 provider 实例

### Task P0-T4：单测 + 三家真实冒烟

**Files:**
- Create: `tests/llm/openai-compat.test.ts`、`tests/llm/retry.test.ts`、`tests/llm/registry.test.ts`
- Create: `scripts/llm-smoke.ts`

- [ ] **Step 1：mock fetch 单测**：SSE 分片（跨 chunk 断行）/tool_calls 累积/usage 事件/429 重试/400 直抛/abort
- [ ] **Step 2：`llm-smoke.ts`**：读真实 config，对三家各跑 ① 文本流式 ② 单 tool_use 回合（喂一个假工具）③ visionModel 看图（一张测试 png）；打印 stopReason + usage + 缓存命中数
- [ ] **Step 3：人工跑通三家冒烟并记录结果到 `docs/desigen/smoke-results.md`**

**Phase 0 验收**：`npx vitest run tests/llm` 全绿；三家冒烟全通。

---

## Phase 1 —— 交互式作品 creator 会话（3 天）

> 边界：仅交互式作品；autoMode 批量此阶段不可用；评审/trends 仍走 CLI。

### Task P1-T1：工具执行器（文件类）

**Files:**
- Create: `src/agent/tools/index.ts`、`read.ts`、`write.ts`、`edit.ts`、`glob.ts`、`grep.ts`

- [ ] **Step 1：`index.ts`**：`ToolExecutor`/`ToolContext`/`ToolExecutorMap` 接口 + `buildCreatorTools()`/`buildEvaluatorTools()`（评审子集：Read/Glob/Grep/Bash）
- [ ] **Step 2：`read.ts`**：utf-8 读，超 20k 截断；扩展名 `.png/.jpg/.jpeg/.webp/.gif` → `ImageBlock`（base64）；**路径断言**：`resolve(path)` 必须位于允许根集合（workDir/dataDir/`~/.claude/skills`/`~/.autoviral`），逃逸→返回 is_error
- [ ] **Step 3：`write.ts`/`edit.ts`**：写前 mkdir -p；edit 要求 old_string 唯一匹配，0 或多重匹配→is_error
- [ ] **Step 4：`glob.ts`**：自实现 `**/*` 递归匹配（不引依赖）
- [ ] **Step 5：`grep.ts`**：`where rg` 探测（缓存结果）→ spawn rg；无则 Node 递归（跳二进制/>1MB 文件）
- [ ] **Step 6：单测 `tests/agent/tools.test.ts`**：路径逃逸拒绝、图片返回 ImageBlock、edit 唯一性

### Task P1-T2：Bash 执行器（Windows 关键）

**Files:**
- Create: `src/agent/tools/bash.ts`
- Create: `tests/agent/bash.test.ts`

- [ ] **Step 1**：探测 `bash.exe`（Git Bash：`C:\Program Files\Git\bin\bash.exe` + `where bash`，结果缓存）；有则 `spawn(bashPath, ["-lc", cmd], {cwd:workDir})`，无则 `spawn("cmd", ["/c", cmd])`
- [ ] **Step 2**：超时默认 120s（input.timeout 可覆写）；stdout+stderr 合并；>30k 截头 10k 留尾 15k
- [ ] **Step 3**：bashBlocklist 正则（默认 `["rm -rf /","format ","del /f /s /q"]`）命中→is_error
- [ ] **Step 4：实测清单**（skills 真实命令样本）：`ffmpeg -i x -af ebur128=peak=true -f null -`、`curl -s localhost:3271/api/works | head -c 200`、`python3 ~/.claude/skills/.../caption_generate.py --help`、管道+重定向组合

### Task P1-T3：AgentLoop 核心

**Files:**
- Create: `src/agent/loop.ts`
- Create: `src/agent/session-store.ts`
- Create: `tests/agent/loop.test.ts`

- [ ] **Step 1：`AgentLoop`**（签名见设计文档 §4.1）：runTurn 工具迭代循环；AskUserQuestion → 发事件+合成 tool_result+`awaiting_user` 结束；三道闸（200 步/30min/同参 3 连）→ LoopGuardError
- [ ] **Step 2：`session-store.ts`**：`loadAgentSession(workId)`/`saveAgentSession(workId, state)`（写 `works/<id>/agent-session.json`，3s 防抖复用 ws-bridge.ts:189-200 模式）；损坏/版本不符 → 返回 null（调用方全新开 loop，限 1 次）
- [ ] **Step 3：单测**：mock provider 跑 3 工具调用回合，断言 messages 序列、turn 边界、守卫触发

### Task P1-T4：ws-compat 事件映射

**Files:**
- Create: `src/agent/ws-compat.ts`
- Modify: `src/ws-bridge.ts`（turn 收尾抽用）

- [ ] **Step 1**：ws-bridge.ts:928-975 的 turn 收尾（saveWorkChat+memory sync+steps 摘要）抽成 `finalizeTurn(session, resultText)` 导出
- [ ] **Step 2：`bindLoopToSession(loop, session, bridge)`**：按设计文档 §4.5 表逐事件实现；text_delta 50ms 合批；tool_result 超 30k 截断
- [ ] **Step 3：对照测试**：构造 loop 事件序列 → 断言发出的 WS 事件名/字段与 CLI 时代一致（事件清单见设计文档 §4.5）

### Task P1-T5：WsBridge 切换 + api.ts 适配

**Files:**
- Modify: `src/ws-bridge.ts`（WsSession/createSession/sendMessage/killSession/isWorkActive/断连宽限）
- Modify: `src/server/api.ts`（waitForCreatorIdle，行 2419-2450）

- [ ] **Step 1**：WsSession 加 `loop?/loopState?/loopTurnPromise?/agentSessionId?`；isWorkActive 加 loopState 判断
- [ ] **Step 2**：createSession/sendMessage 改走 loop（llm 配置缺失时抛可读错误"未配置 llm.providers"）；buildSystemPrompt 产物原样作 system
- [ ] **Step 3**：killSession 加 `loop?.abortTurn()`；断连宽限杀进程改 abortTurn
- [ ] **Step 4**：waitForCreatorIdle：`session.loopTurnPromise` 等待分支
- [ ] **Step 5：验收 6 项**（实施方案 §3 验收：① WS 事件序列一致 ② kill 还原续聊 ③ AskUserQuestion 闭环——**重点验证模型对 tool_result 回填答案的接续理解** ④ A/B 对比 ⑤ bash 实测 ⑥ **research 阶段 Kimi $web_search 真实搜索可用 + 一次性 token 实测与单部成本粗算**（不等 Phase 3 记账系统，提前验证 ≤20 元目标可达性））

### Task P1-T6：工程债 C1/C2 ✅ 2026-08-17

- [x] code-scene postinstall 加 timeout（packages/code-scene 安装脚本）— `src/postinstall.ts` execSync 加 10min timeout
- [x] code-scene 渲染测试串行化（vitest single-thread 或文件锁）— vitest projects:`render-serial` 单 fork + fileParallelism:false,其余测试仍并行
- [x] code-scene generated 文件清理（渲染成功后 rm 临时 project 文件）— worker.mjs finally 清理（成败都清）+ 服务端 spec.json 同步清理;存量 60+ 已清
- [x] code-scene 布局 1080x1920 硬编码参数化（读请求 width/height）— 新增 src/layout.ts 设计空间常量+designScale,三场景内容挂缩放容器;720x1280 实渲染抽帧验证
- [x] 3 个测试 flake（api-bench/api-digital-human/dual-output）定位修复或 quarantine — 全量并行复跑通过;归因=与 code-scene 真实渲染(Edge+ffmpeg)并行抢 CPU,render-serial 拆分后消除竞争源,未 quarantine

### Task P1-T7：设置页 llm provider 段（首期显性化，用户指定）✅ 2026-08-17

> 目标：直连 API 的**接口地址与 API key 在设置页可见、可配、可导出**——为未来打包分发到其他电脑做准备（新机器只需在设置页填 key 即用）。六阶段模型下拉的精细路由 UI 仍在 Phase 3，本期先把三家 provider 管起来。

**Files:** Modify `src/server/api.ts`（GET/PUT /api/config 增加 llm 段序列化，apiKey 脱敏返回——`sk-***` 掩码，提交完整新值才覆盖）、`web/src/pages/SettingsPanel.svelte`

- [x] GET /api/config 返回 `llm.providers` 三家配置（apiKey 掩码）— presentLlm:预设补全+`sk-xxx***尾4` 掩码,明文不出接口
- [x] PUT /api/config 接受 llm 段整组更新（掩码值原样保留不覆盖）— mergeLlm:含 `***` 保留原值、空串显式清除、未提交字段保留;保存后 `_resetProviders()` 热生效免重启
- [x] SettingsPanel 新增「大模型直连」段：DeepSeek / Kimi Coding Plan / GLM Coding Plan 三张卡片，各含 apiKey（密码框）、baseUrl（默认值可改）、visionModel、启用开关、连通性测试按钮（调一次最便宜的 models 列表或 1-token 请求，显示 ✅/❌+延迟）— POST /api/llm/ping 实测:deepseek 300ms/kimi 167ms/glm 115ms
- [x] 配置存 `~/.autoviral/config.yaml`（本机），文档注明打包分发时该文件即为迁移单元

> **打包迁移单元**:`~/.autoviral/config.yaml` 即为分发迁移单元——拷贝该文件到新机器同路径,在设置页「大模型直连」填入三家 key 即可用;其余(隧道/素材源/调研)同页可配。测试:tests/server/api-config-llm.test.ts 7 例。

**Phase 1 验收**：实施方案 §3 五条 + C1/C2 关闭。

### Task P1-T8：Kimi $web_search builtin_function 两段协议（验收暴露缺口，用户批准补齐）✅ 2026-08-17

> 验收项⑥实测发现：Kimi coding 端点的 $web_search 是**服务端执行**的内置工具，需 builtin_function + 逐字回填两段协议；原 provider 把工具统一映射为 function，research 阶段实际无搜索能力。

- [x] types：ToolDef.builtin / ToolUseBlock.builtin+rawArguments / ToolResultBlock.name
- [x] openai-compat：builtin_function 映射、流式解析捕获 type、回填逐字序列化（rawArguments 避免 parse/stringify 失真）
- [x] loop：deps.builtinTools 合并下发；builtin 工具不本地执行、arguments 逐字回填为 tool 消息
- [x] ws-bridge：preset.builtinSearchTool 声明（kimi=$web_search），createSessionApi 按 provider 挂载；systemPrompt 追加工具名映射声明（**关键**：skills 按 CLI 命名写死 WebSearch，不声明时 kimi 退回 curl 抓站——首轮验收实测连续 100+ 次 bash curl 打转）
- [x] 测试：tests/llm/builtin-search.test.ts 3 例；scripts/kimi-search-probe.ts live 实证（inputTokens 2472 注入、回答含 2026-08 真实热点）

**Phase 1 验收结果（2026-08-17）**：

| 验收项 | 结果 |
|---|---|
| ① WS 事件序列一致 | ✅ live 两轮：tool_use/turn_complete/session_state 逐字一致 |
| ② kill 还原续聊 | ✅ 08-16 e2e（killSession→abortTurn，agent-session.json 还原） |
| ③ AskUserQuestion 闭环 | ✅ 08-16 e2e + 08-17 驱动自动应答跨回合续跑 |
| ④ A/B 对比 | ⚠️ 见下「kimi 纪律性」——机制可用，行为待 Phase 2 结构压缩后复评 |
| ⑤ bash 实测 | ✅ 单回合 74+ 次调用全执行（ffmpeg/curl 本地 API/python 脚本） |
| ⑥ Kimi $web_search + token 成本 | ✅ 搜索两段协议 live 跑通（两轮驱动各调 1 次即得真实结果）。成本：kimi 为 Coding Plan 订阅制（边际≈0）；DeepSeek 阶段按量+前缀缓存。单部粗算：research 一轮含搜索 ≈1 万 tokens（订阅内），plan/assembly 待 Phase 3 记账实测 |

**遗留（进 Phase 2 输入）**：kimi-for-coding 在 material-search 阶段纪律性差——$web_search 首调即成功，但随后陷入长 bash 探索链（本地 API 探测/参数猜测式重试 code-scene 渲染），单回合超 15min 未收敛。机制（loop/回填/事件）全部正确，属模型-提示词适配问题：P2-T2 结构压缩 + research 阶段提示词瘦身时复评；必要时 research 改 deepseek 主持、kimi 仅作搜索后端。

---

## Phase 2 —— 评审 + 无人值守 + 机器门禁（3 天）

### Task P2-T1：评审 loop

**Files:** Create `src/agent/evaluator.ts`；Modify `src/ws-bridge.ts`（spawnEvaluator）、`src/server/api.ts`（runEvaluation 不动）

- [ ] `parseEvalResultText` 从 ws-bridge.ts:1205-1227 抽出共享
- [ ] `runApiEvaluator`：独立 AgentLoop、全新 messages、buildEvaluatorTools(visionModel)
- [ ] ImageBlock 回合路由 visionModel；无 visionModel → 配置校验期报错（assets/assembly 评审禁用）
- [ ] 验收：评审日志确认 ImageBlock 进请求；eval_blocked 3 轮流复现

### Task P2-T2：结构压缩 + autoMode 解禁

**Files:** Create `src/agent/compact.ts`；Modify `src/agent/loop.ts`

- [ ] `estimateTokens`（CJK×0.6+其他×0.25）；`maybeCompact(messages, threshold=120k)`：留 messages[0]+最近 8 条，中段换确定性摘要 + steps/<step>.json 阶段摘要注入
- [ ] autoMode 作品允许走 API loop
- [ ] 验收：autoMode 作品端到端（含人为 fail→打回→修复→pass）；出片 ≤40min 对照

### Task P2-T3：机器门禁（A1/A2/B2）

**Files:** Modify `src/server/api.ts`（advance 端点）、`src/services/quality-gate.ts`

- [ ] advance(assembly) 前置校验函数 `assertAssemblyDeliverables(workId)`：final.mp4 存在 / publish-text.md 存在 / quality-report.json 的 videoPath 指向 final.mp4 且 mtime ≥ final.mp4 mtime / subs.ass 单行 ≤15 字且 CPS≤8——任一缺失返回 400 + 可读缺失清单
- [ ] quality-gate.ts 响度项改 ebur128 实测（I∈[-16,-14]、TP≤-1.5），废弃 volumedetect mean
- [ ] 单测：缺 publish-text 的 advance 被 400

### Task P2-T4：配额防护（A3）+ A4 回归测试

**Files:** Modify `src/services/work-queue.ts`；Create `tests/server/reconcile.test.ts` 增补

- [ ] ws-compat/loop 层把 "usage limit"/"quota" 错误文本冒泡为 `QuotaExhaustedError`；work-queue tick 捕获 → 全部 running 项置 paused + 30min 后单次试探（指数回退），不 incrementResumeAttempts
- [ ] reconcile 会话感知（8-16 已修）回归用例：活跃会话 + final.mp4 存在 → 不转正

**Phase 2 验收**：实施方案 §4 五条。

---

## Phase 3 —— 全量切换 + 模型路由 + 设置页（3 天）

### Task P3-T1：六个 CLI runner 切换（DeepSeek 审查补全）

**Files:** Modify `src/services/llm-json.ts`、`src/services/template-clone.ts`、`src/services/template-research.ts`、`src/services/trend-research.ts`、`src/server/api.ts`（runCliBrief，行 1343）、`src/test-runner.ts`（行 378）、`src/test-evaluator.ts`（行 220）

- [ ] runJsonPrompt → provider.chatJson（重试/提取复用，spawn 分支删除）
- [ ] runVisionCli → chatStream + ImageBlock（图片不再落盘走 Read）
- [ ] runResearchCli（**模板调研学习**）→ chatJson
- [ ] **trend-research.ts collectTrends（定时趋势调研，生产路径）→ chatJson + Kimi $web_search**
- [ ] **api.ts runCliBrief（趋势 fallback）→ chatJson**（script 档模型）
- [ ] **test-runner.ts / test-evaluator.ts（测试辅助，haiku）→ chatJson**（决策：统一切 API，不做豁免——保持"无 CLI 残留"验收可判定）

### Task P3-T2：模型路由生效 + 记账熔断

**Files:** Create `src/services/llm-usage.ts`（SQLite 表 `llm_usage(ts,work_id,stage,provider,model,input_tokens,output_tokens,cache_read,cost_yuan)`）；Modify `src/agent/loop.ts`（usage 事件落账）

- [ ] 每次 chatStream 完成写一条 usage；成本按 provider 价格表（config 可配 `llm.priceTable`）
- [ ] 日累计超 `budget.dailyLimitYuan` → 队列 paused + 广播错误事件

### Task P3-T3：设置页六阶段模型路由（provider 管理已在 P1-T7 首期交付）

**Files:** Modify `web/src/pages/SettingsPanel.svelte`、`App.svelte`、`Explore.svelte`、`Works.svelte` 模型选择器

- [ ] 六阶段模型下拉（选项从 /api/config 的 llm.providers 动态生成，格式 "provider:model"）
- [ ] 替换四处 opus/sonnet/haiku 硬编码（SettingsPanel.svelte:42-44、App/Explore/Works 选择器）

### Task P3-T4：B1 数据回流评估表

**Files:** Create `src/services/feedback-loop.ts`；Modify `src/db/migrate.ts`（v24：`topic_scores` 表）

- [ ] 发布 48h 后抓三率（复用 analytics-collector 通道）→ 写回 topic-scorecard 权重
- [ ] 验收：三率回流有数据

**Phase 3 验收**：模板克隆双平台各通一个（顺带 C3，需用户扫码 5 分钟）；usage 分模型命中；设置页保存生效。

---

## Phase 4 —— trends + 删 CLI（1 天）

- [ ] trends 会话事件平移（search_query/search_result/analyzing/research_done，ws-bridge.ts:771-804 过滤逻辑平移到 ws-compat）
- [ ] 删除全部 9 处 CLI 调用：ws-bridge.ts spawnCli/spawnEvaluator/resolveClaudeCommand、llm-json.ts spawn、template-clone.ts、template-research.ts、trend-research.ts、api.ts runCliBrief、test-runner.ts、test-evaluator.ts；`cliSessionId` 读写停用（works.cli_session_id 列保留不迁移）
- [ ] `rg "claude" src/ scripts/ tests/` 只剩注释与测试 fixture
- [ ] 全量 `npx vitest run` + autoMode 批量作品总验收

---

## 总验收标准（不变）

1. autoMode 批量作品全程 API：出片 ≤40min（基线 2h+）
2. 机器门禁 critical 全过（三件齐/响度/字幕/QC 对象）
3. 单部片 LLM 成本 ≤20 元（usage 可查）
4. A/B 质量无明显劣化
5. 全量测试绿；无 CLI 残留

## 执行纪律

1. 每 Task 完成：build + 相关测试 + 勾选 feature.json 状态
2. 每 Phase 完成：验收项全过才进下一 Phase
3. 校准批次（166/bcf）继续在 CLI 模式跑完，与本改造互不阻塞
