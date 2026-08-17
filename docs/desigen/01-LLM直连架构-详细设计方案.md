# AutoViral LLM 直连架构 —— 详细设计方案

> 版本：v1.0 · 2026-08-16
> 状态：待用户批准
> 配套文档：《AutoViral LLM 直连架构 —— 详细实施方案.md》

---

## 1. 背景与问题定义

### 1.1 现状机制

AutoViral 的创作 agent 目前完全建立在 spawn claude CLI 子进程之上：

```
浏览器 ←WS→ WsBridge ←stdout NDJSON (stream-json)→ spawn `claude -p --resume` → 订阅配额
```

- 每回合一个新进程，`--resume <cliSessionId>` 恢复会话（ws-bridge.ts:719-733）
- stdin 不用；stdout NDJSON 事件流；`type:"result"` 事件判定回合结束
- 进程退出是常态，会话存活靠 120s 活动宽限（isWorkActive, ws-bridge.ts:129-134）
- 项目零 LLM SDK 依赖，无 apiKey/baseUrl 配置项，鉴权完全外包给 CLI 登录态

**CLI spawn 全量清单（9 处，2026-08-16 经 DeepSeek 审查 + grep 验证补全）**：

| # | 位置 | 用途 | 迁移期 |
|---|------|------|--------|
| 1 | ws-bridge.ts:736 spawnCli | creator 会话 | Phase 1 |
| 2 | ws-bridge.ts:1114 spawnEvaluator | 阶段评审 | Phase 2 |
| 3 | llm-json.ts:82 runJsonPrompt | 文案/脚本三段式 | Phase 3 |
| 4 | template-clone.ts:58 runVisionCli | 模板克隆视觉分析 | Phase 3 |
| 5 | template-research.ts:54 runResearchCli | **模板调研学习**（非趋势调研！文件头注明"模板调研学习 2026-08-03"） | Phase 3 |
| 6 | trend-research.ts:277 collectTrends | **定时趋势调研**（scheduler.ts 调用，生产路径） | Phase 3 |
| 7 | api.ts:1343 runCliBrief | 趋势调研 haiku fallback（数据不足时补话题，生产路径） | Phase 3 |
| 8 | test-runner.ts:378 | A/B 测试模拟用户回复（haiku） | Phase 3 |
| 9 | test-evaluator.ts:220 | 测试质量评估（haiku） | Phase 3 |

> 注：`resolveClaudeCommand`（ws-bridge.ts:75）只是命令解析器，不 spawn，不计入。

### 1.2 实测问题（2026-08-16 校准批次，4 部作品）

| 问题 | 实测数据 |
|------|---------|
| 出片慢 | 单部 2+ 小时；plan 阶段 44-119min、assets 阶段 27-180min |
| O(n²) 恶化 | 每回合全量重读会话史；chat.jsonl 滚到 5-16MB，越往后越慢 |
| 配额墙 | 4 部作品一天撞穿订阅配额（403 usage limit），停摆约 1 小时 |
| 不可控 | 无法压缩上下文、无法分阶段换模型、无法流式输出 |
| 评审额外开销 | 每阶段评审是独立 CLI spawn（注入 8k 截断 step history + 历史评审，api.ts:2470-2484） |

### 1.3 用户决策（2026-08-16，三条顶层设计）

1. **模型策略**：经济性优先的多模型组合，首期覆盖三家——DeepSeek（v4-pro 策划/评审/合成编排、v4-flash 机械步骤、v4-vision 看图）、Kimi Coding Plan（K2，联网搜索优势）、GLM Coding Plan（GLM-4.6，评审交叉验证）。DeepSeek V4 已具备多模态能力（2026-04 识图模式上线），视觉输入约 $0.14/M tokens。
2. **能力保障**：工具/skills/agent 循环全部自实现，不依赖 CLI 内置能力；评审门机制不动，作为质量兜底。
3. **彻底抛弃 CLI**：全面直连，不留 fallback 开关；CLI 代码在最后一期删除。

### 1.4 设计目标

| 目标 | 指标 |
|------|------|
| 提速 | 单部片出片 ≤40min（基线 2h+） |
| 成本 | 单部片 LLM 成本 ≤20 元，按量可预测，无配额墙 |
| 质量 | 不降——评审门/critical 条款全部保留，机器门禁加强 |
| 兼容 | 前端 WS 事件逐字兼容，Studio/Explore 页面零改动 |
| 可观测 | llm_usage 逐笔记账，接 budget 熔断 |

---

## 2. 总体架构

```
浏览器 ←WS→ WsBridge ←LoopEvent→ AgentLoop ──→ LlmProvider ──→ DeepSeek API (OpenAI 兼容)
              ↑                    │
              └── ws-compat 翻译 ──┘   （事件逐字映射，前端零感知）
```

**核心原则**：WsBridge 的对外契约一律不变——WS 事件名与字段、isWorkActive、createSession/sendMessage/spawnEvaluator/killSession 签名。work-queue、watchdog、runEvaluation、全部前端页面零改动。

**目录结构**：

```
src/
  llm/                    # LLM client 层（新建）
    types.ts              # 消息/工具/事件类型
    openai-compat.ts      # DeepSeek 等 OpenAI 兼容协议
    anthropic.ts          # Anthropic 协议（二期预留）
    registry.ts           # 分阶段模型路由
    retry.ts              # 指数退避重试
  agent/                  # 进程内 agent loop（新建）
    loop.ts               # AgentLoop 核心
    session-store.ts      # agent-session.json 持久化
    compact.ts            # 上下文压缩
    ws-compat.ts          # LoopEvent → WS 事件映射
    evaluator.ts          # 评审 loop
    tools/                # 9 个工具执行器
      index.ts bash.ts read.ts write.ts edit.ts
      glob.ts grep.ts websearch.ts ask-user.ts
```

---

## 3. LLM client 层设计（src/llm/）

### 3.1 类型系统（types.ts）

```ts
export type Role = "user" | "assistant";
export interface TextBlock       { type: "text"; text: string }
export interface ThinkingBlock   { type: "thinking"; thinking: string }
export interface ToolUseBlock    { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
export interface ImageBlock      { type: "image"; mediaType: string; base64: string }
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface AgentMessage { role: Role; content: ContentBlock[] }

export interface ToolDef {
  name: string;               // 与 CLI 工具同名：Read/Write/Edit/Glob/Grep/Bash/WebSearch/AskUserQuestion
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;             // 独立 system 字段——prompt caching 的前提
  messages: AgentMessage[];
  tools: ToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; block: ToolUseBlock }       // input JSON 完整后一次性发（对齐 CLI 行为）
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number };

export interface LlmProvider {
  readonly name: string;
  readonly protocol: "anthropic" | "openai";
  chatStream(req: ChatRequest, onEvent: (ev: StreamEvent) => void): Promise<{ stopReason: string; assistant: AgentMessage }>;
  chatJson<T>(prompt: string, opts: { model: string; timeoutMs?: number; maxAttempts?: number }): Promise<T>;
}
```

### 3.2 OpenAI 兼容 provider（openai-compat.ts）

**首期必须覆盖三家**（均为 OpenAI ChatCompletions 兼容协议，同一实现按配置切换）：

| Provider | baseUrl | 说明 |
|----------|---------|------|
| DeepSeek | `https://api.deepseek.com/v1` | v4-pro / v4-flash；**公开 API 纯文本，无视觉模型**（2026-08-16 冒烟实证：`image_url` 400 拒绝，官方无 vision model id） |
| Kimi（Coding Plan） | `https://api.kimi.com/coding/v1` | **sk-kimi-\* key 仅在此端点有效**（api.moonshot.cn/v1 返回 401）；模型 ID：`kimi-for-coding`（文本/工具/视觉三合一，冒烟全通） |
| GLM（Coding Plan） | `https://open.bigmodel.cn/api/paas/v4` | **按用户约束仅用于视觉识别**：glm-4v（冒烟通过），项目视觉主力 |

> 三家均另提供 Anthropic 兼容端点（如 `api.moonshot.cn/anthropic`），若后续要接 anthropic.ts 可直接复用同一 key；首期统一走 OpenAI 兼容协议，一套代码覆盖三家。

- POST `{baseUrl}/chat/completions`，`stream:true`，`Authorization: Bearer <key>`
- 协议转换：
  - `ToolUseBlock` → `assistant.tool_calls[]`；`ToolResultBlock` → `role:"tool"` 消息 + `tool_call_id`
  - `ImageBlock` → `image_url: {url: "data:<mediaType>;base64,..."}`
  - 流式 `tool_calls` 的 `function.arguments` 字符串分片累积，完整后 `JSON.parse` 一次性发 `tool_use` 事件（与 CLI 按完整 block 发行为对齐）
  - reasoning_content（GLM 有）→ `thinking_delta`；Kimi/DeepSeek 无 thinking 输出则跳过
  - Kimi 内置 `$web_search`（builtin_function）——WebSearch 工具的 provider 级实现候选（实测后定）
- **前缀缓存**：DeepSeek/Kimi 均自动前缀缓存（命中价约为未命中的 1/30）。命中纪律：system + tools 恒定在最前、messages 只追加不改写、同作品同阶段请求前缀一致。**例外注明**：Phase 2 的 compact.ts 中段压缩属于"改写"，每次压缩后本会话前缀缓存失效——压缩是低频操作，属可接受代价，不影响纪律主体。
- 视觉：**GLM `glm-4v` 为项目视觉主力**（用户约束：GLM 仅用于图片/视频识别）；Kimi `kimi-for-coding` 视觉能力备用；DeepSeek 公开 API 无视觉（2026-08-16 实证）——`visionModel` 配置项按 provider 各自指定，缺省回退 glm。
- **联网搜索（Phase 1 交付，非三期）**：Kimi 内置 `$web_search`（builtin_function）是三家内唯一现成的搜索能力，research 阶段是流水线第一环、强依赖搜索，不得断档——`name==="kimi"` 的 provider 在 tools 中注入 `{"type":"builtin_function","function":{"name":"$web_search"}}`，loop 侧将其映射为 WebSearch 工具事件（搜索结果在 tool_calls 回包中返回，具体字段以冒烟实测为准并记录 smoke-results.md）。Tavily/Bing 作为三期增强保留。

### 3.3 Anthropic provider（anthropic.ts，二期预留）

POST `/v1/messages` + SSE；`system` 与 tools 末尾打 `cache_control:{type:"ephemeral"}` 断点；`input_json_delta` 累积成 ToolUseBlock。一期不实现，接口预留。

### 3.4 模型路由（registry.ts）

```ts
export function resolveModelFor(config: Config, stage: StageKey): { provider: LlmProvider; model: string }
// 规则: llm.models[stage] → "providerKey:modelId" 或裸 modelId（用 defaultProvider）
```

| 阶段 | 示例路由 | 理由 |
|------|------|------|
| research | kimi:kimi-k2（**绑死 Kimi**：$web_search 是 Phase 1 唯一现成搜索） | 趋势整理 + 联网搜索刚需 |
| script（文案/脚本） | deepseek:v4-flash | 三段式一次性生成，最便宜 |
| plan | deepseek:v4-pro（或 glm:glm-4.6） | 创意核心，强模型 |
| assets | deepseek:v4-flash | 执行层，按分镜调用工具 |
| assembly | deepseek:v4-pro（或 glm:glm-4.6） | 合成编排，出错自愈需要强模型 |
| eval | 见下方"视觉评审模型策略" | 评审质量兜底，三家交叉验证防同源盲区 |
| 模板克隆/视觉分析 | deepseek:v4-vision（或 kimi vision / glm-4v） | 纯视觉任务 |

> 路由表是配置而非代码——三家 coding plan 的额度/价格变动时只改 config.yaml。

**视觉评审模型策略（2026-08-16 审查修订）**：凡涉及图片的评审阶段（assets/assembly），**评审 loop 全程使用 vision 模型**（glm-4v / deepseek-v4-vision），**禁止回合内热切换**——同一 messages 序列在文本/视觉模型间切换会导致历史上下文断裂（vision 模型拿不到文本模型的前缀，且跨模型 tool_call 配对失效）。纯文本阶段评审（research/plan）用 eval 配置的文本模型。

### 3.5 重试（retry.ts）

照搬 `llm-json.ts:47-68` 已验证语义：`withRetry(fn, {maxAttempts:3, backoffs:[5s,15s,30s]})`；HTTP 429/500/502/503/529 与网络错误重试；4xx 打 noRetry 直接抛。**流式一旦开始输出则不再整体重试**（错误上抛 loop 层处理），避免重复输出混入。

### 3.6 配置（config.ts）

```ts
export interface LlmProviderConfig {
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey: string;
  visionModel?: string;        // 不配则该 provider 不可用于看图场景（配置校验期报错）
}
export interface LlmConfig {
  defaultProvider: string;
  providers: Record<string, LlmProviderConfig>;
  // 首期示例: {
  //   deepseek: { protocol:"openai", baseUrl:"https://api.deepseek.com/v1", apiKey, visionModel:"deepseek-v4-vision" },
  //   kimi:     { protocol:"openai", baseUrl:"https://api.moonshot.cn/v1", apiKey, visionModel:"moonshot-v1-32k-vision-preview" },
  //   glm:      { protocol:"openai", baseUrl:"https://open.bigmodel.cn/api/paas/v4", apiKey, visionModel:"glm-4v" },
  // }
  models?: { research?; plan?; assets?; assembly?; eval?; script? };  // 值形如 "deepseek:v4-pro" 或裸模型名
  guard?: {
    maxStepsPerTurn?: number;        // 默认 200
    maxTurnMinutes?: number;         // 默认 30
    dailyTokenBudget?: number;       // 成本熔断
    bashBlocklist?: string[];        // bash 命令黑名单正则
  };
}
// Config 加 llm?: LlmConfig；env 覆盖 AUTOVIRAL_LLM_API_KEY / AUTOVIRAL_LLM_BASE_URL
```

---

## 4. 进程内 agent loop（src/agent/）

### 4.1 loop 核心（loop.ts）

```ts
export class AgentLoop {
  messages: AgentMessage[];                    // 权威会话状态
  state: "idle" | "running" | "aborted";
  async runTurn(userText: string): Promise<{ resultText: string; stopReason: string }>;
  abortTurn(): void;
}
```

`runTurn` 循环：

1. push user 消息（首回合 system 走 ChatRequest.system 独立字段——prompt caching 前提，不再像 CLI 拼进 prompt 文本）
2. `provider.chatStream` → onEvent 直接转发 onLoopEvent（ws-compat 翻译成 WS 事件）+ 累积 assistant blocks
3. `message_stop`：
   - `stopReason==="tool_use"` → 逐个执行工具（try/catch → tool_result is_error），push assistant + tool_result 消息，回到 2
   - **AskUserQuestion 特殊（修订版：保持 tool_use/tool_result 配对）**：发 tool_use 事件后结束回合（`awaiting_user`），loop 记录 `pendingAskToolUseId`；**用户的下一条输入不作为新 user 消息，而是作为该 pending tool_use 的 tool_result 回填**（content=用户答案原文），然后继续同一逻辑回合——模型看到的序列是"提问 → 收到答案"，配对完整，语义无损。若用户发送的是与问题无关的新指令，则降级为新 user 消息（pending 作废并补一条"用户未回答"的 tool_result 保持配对合法）
   - 其他 → 回合结束，resultText = 本回合 TextBlock 拼接（与 CLI result 缺失回落 turnText 行为一致）
4. 守卫三道闸：工具步数 >200 / 墙钟 >30min / 同工具同参 3 连 → `LoopGuardError` → 映射 `cli_exited{code:1}` 走现有 runner/watchdog 恢复路径

**回合粒度对齐**：CLI 一个 `-p` 回合 = 一条消息跑完所有工具迭代后退出；loop 的 `runTurn` 语义完全相同，runner/evaluator/waitForCreatorIdle 的全部既有逻辑无需重设计。

### 4.2 持久化（session-store.ts）

**关键决策**：chat.jsonl 无法还原 LLM messages（tool_use 的 input 被字符串化、tool_use_id 配对丢失、无 system），故新增权威层：

- `works/<id>/agent-session.json`：`{version:1, sessionId:"api-<uuid>", messages[], createdAt, updatedAt}`，回合结束写 + 3s 防抖增量写
- chat.jsonl（追加）/ chat.json（快照）/ steps/\<step\>.json（回合摘要）**三层维持现状双写**——UI 回放、TestRunner、阶段摘要、memory sync 全不受影响
- 还原失败（损坏/版本不符）→ 记日志 + 全新 loop 重试 1 次（复刻 ws-bridge.ts:1007-1048 的 staleRetried 模式）
- `works.cli_session_id` 字段停止写入（DB 无迁移，历史数据不动）

### 4.3 工具执行器（tools/）

工具名**逐字沿用 CLI 命名**（Read/Write/Edit/Glob/Grep/Bash/WebSearch/AskUserQuestion）——system prompt、skill 文件、评审 prompt 全部按这些名字写成。

| 工具 | 实现要点 |
|------|---------|
| Bash | 优先 spawn `bash.exe`（Git Bash 语义——skills 命令全是 Unix 语法；探测缓存，fallback cmd）；cwd=workDir；120s 超时（input 可覆写）；stdout+stderr 合并；超 30k 字符截头 10k 留尾 15k 插 `[...truncated...]`；bashBlocklist 正则拦截危险命令 |
| Read | 文本超 20k 截断；**图片扩展名（png/jpg/jpeg/webp/gif）→ ImageBlock(base64)**——视觉能力入口；模型无视觉时返回错误文本提示 |
| Write/Edit | 标准实现；edit 做 old_string 唯一匹配校验 |
| Glob | 自实现（fs.readdir 递归 + 模式正则化，百行内） |
| Grep | 探测 `rg` 存在则 spawn，否则 Node 递归扫描（跳过二进制） |
| WebSearch | 一期：DeepSeek 无内置搜索 → 不注册该工具，system prompt 引导用 curl/WebFetch 替代（与今天断网时降级行为一致）；三期：接 Tavily/Bing API |
| AskUserQuestion | execute 为 no-op，语义在 loop 层（见 4.1） |

**权限边界**：工具全自实现 = 默认全允许（等价 CLI 的 `--dangerously-skip-permissions`）。加固：bashBlocklist + 文件工具 resolve 后断言不逃逸允许根集合（workDir / dataDir / ~/.claude/skills / ~/.autoviral）。评审器工具面缩为只读（Read/Glob/Grep/Bash）。

### 4.4 上下文压缩（compact.ts）

- **一期**：工具输出源头截断（见 4.3），无结构压缩
- **二期**（autoMode 解禁前置硬约束）：`maybeCompact(messages)`——token 粗估（CJK 字符×0.6 + 其他×0.25）超 120k 时：保留 messages[0] 任务指令 + 最近 8 条，中间段替换为一条确定性摘要消息（每条 user text 原文、每个 assistant 最后 text 截 500 字、tool_use 只留 name+input 截 80 字），并注入已落盘的 steps/\<step\>.json 阶段摘要
- **三期**：LLM 摘要（调 script 档 v4-flash 生成）

### 4.5 WS 事件逐字映射（ws-compat.ts）

| Loop 内部事件 | WS event | data 字段 | 副作用 |
|---|---|---|---|
| runTurn 开始 | `session_state` | `{idle:false}` | — |
| loop 就绪 | `session_ready` | `{workId, cliSessionId:"api-<uuid>"}` | — |
| text_delta（50ms 合批） | `assistant_text` | `{workId,text}`；评审带 `source:"evaluator"` | push ChatBlock + jsonl 追加 + 防抖存 |
| thinking_delta | `assistant_thinking` | `{workId,text}` | collapsed block |
| tool_use（input 完整） | `tool_use` | `{workId,name,input}` | AskUserQuestion 前端自动特判，零处理 |
| tool_result 产出 | `tool_result` | `{workId,content}` | collapsed block |
| 回合正常结束 | `turn_complete` | `{workId,idle:true,result,sessionId,historyLength}` | saveWorkChat + memory sync + steps/<step>.json 追加（ws-bridge.ts:928-975 整段搬入） |
| 异常/守卫/abort | `cli_exited` | `{workId,code:1,signal:null}` | runner/watchdog 现有恢复路径 |
| 浏览器连接回放 | `session_state`+`message_history` | — | handleBrowserConnection 零改动 |
| trends 事件（四期） | `search_query`/`search_result`/`analyzing`/`research_*` | 按 ws-bridge.ts:771-804 过滤逻辑平移 | — |

### 4.6 评审 loop（evaluator.ts）

```ts
export async function runApiEvaluator(
  session: WsSession, evalPrompt: string,
  opts: { provider: LlmProvider; model: string; visionModel?: string },
): Promise<EvalResult>;
```

- 独立 AgentLoop 实例，**每轮全新 messages**（保持"评审从磁盘重读文件"的现有决策，api.ts:2498 注释）
- **视觉策略（修订）**：涉及图片的评审阶段（assets/assembly），评审 loop **全程**使用 visionModel（glm-4v / deepseek-v4-vision），**禁止回合内热切换**——同一 messages 序列跨模型切换会导致前缀断裂与 tool_call 配对失效；纯文本阶段（research/plan）评审用 eval 配置的文本模型
- `parseEvalResultText` 从 ws-bridge.ts:1205-1227 抽出去重（先 ```json 围栏再整串 parse，失败兜底 pass）
- `WsBridge.spawnEvaluator` 改调 runApiEvaluator；`session.evalAbort: AbortController` 替代 evalProcess，killSession 一并 abort

---

## 5. WsBridge 适配清单（src/ws-bridge.ts 修改点）

| 位置 | 改动 |
|------|------|
| WsSession（行 40-53） | 加 `loop?/loopState?/loopTurnPromise?/agentSessionId?` |
| isWorkActive（行 129-134） | `loopState==="running"` 等价进程存活；120s 宽限不变（StreamEvent 刷 lastActivityAt） |
| createSession（行 399-471） | 改走 loop：agent-session.json 还原 messages；首发复用 buildSystemPrompt 产物（零改动） |
| sendMessage（行 522-592） | `session.loop.runTurn(text)`；**免 resume**；withSpawnLock 串行锁复用 |
| spawnCli（行 717-1087） | 整段删除（Phase 4）；此前停止被调用 |
| spawnEvaluator（行 1093-1279） | 改调 runApiEvaluator；CLI 实现 Phase 4 删除 |
| killSession（行 594-617） | 追加 `loop.abortTurn()` / `evalAbort.abort()` |
| 浏览器断连宽限（行 1336-1361） | 杀进程改 abortTurn，其余原样 |
| turn 收尾（行 928-975） | 抽成可复用方法供 ws-compat 调用 |
| api.ts waitForCreatorIdle（行 2419-2450） | `session.loopTurnPromise` 等待分支（约 5 行） |

**零改动**：work-queue.ts 调度语义、server/index.ts、runEvaluation 流程、buildEvalPrompt、buildSystemPrompt、全部前端、持久化格式。

---

## 6. 风险清单与对策

| # | 风险 | 等级 | 对策 |
|---|------|------|------|
| R1 | DeepSeek 长链路 agentic 可靠性弱于 Claude（指令遵循/工具调用稳定性/自愈能力） | **高** | 评审门不动作质量兜底；Phase 1 强制同作品 CLI/API A/B 对比；一次性生成步骤全放 flash；eval 用 pro |
| R2 | skills 不被自动挂载（CLI 自动挂 skills 目录；loop 只发路径清单靠模型自觉 Read）——对 agentic 可靠性更弱的 DeepSeek/Kimi/GLM，与 R1 相乘 | **高（升级）** | **强制兜底（非可选）**：loop 首回合自动注入当前阶段必读 module 内容全文（ws-bridge.ts:307-313 清单），不只给路径；A/B 对比验证 skill 遵循度 |
| R3 | 上下文膨胀（autoMode 单会话数小时） | 中 | autoMode 解禁硬约束 = Phase 2 结构压缩先就位 |
| R4 | 成本失控（无配额墙后死循环=烧钱） | 中 | 三道闸 + llm_usage 逐笔记账 + dailyTokenBudget 熔断（触发即停队列并广播错误）。**Phase 1 A/B 时即做一次性 token 实测+成本粗算**（不等 Phase 3 记账系统），提前验证"单部 ≤20 元"可达性 |
| R5 | Windows bash 语义（skills 全是 Unix 命令） | 中 | bash.exe 探测为首期必测项；fallback cmd 时已知命令差异清单 |
| R6 | WebSearch 缺口 → research 阶段断档 | **中（升级）** | **Phase 1 交付**：Kimi `$web_search` builtin 注入（§3.2），research 阶段绑死 Kimi 路由；三期 Tavily/Bing 增强 |
| R7 | 流式增量渲染差异（CLI 按 block 发，loop 按 delta 发） | 低 | ws-compat 50ms 合批成块；Studio.svelte 追加语义实测 |
| R8 | 双写漂移（agent-session.json vs chat.jsonl crash 时点不同步） | 低 | session 文件写在 chat.jsonl 之后、以 session 文件为准；UI 侧差异无害（仅展示） |
| R9 | 视觉模型质量（三家视觉模型看图评审能力未经本场景验证） | 中 | Phase 2 验收项：评审看图实测报告；不达标则 eval 换另一家视觉 |
| R10 | AskUserQuestion 接续理解退化（用户答案以 tool_result 回填，模型能否正确接续） | 低 | Phase 1 验收重点验证项；配对保持设计见 §4.1 |

---

## 7. 与现有系统的能力等价性论证（回答"能力会不会大大降低"）

| CLI 提供的能力 | 直连后的等价物 | 差异 |
|---|---|---|
| 工具调用（Read/Write/Bash…） | 自实现 9 个执行器（4.3） | 功能等价；工具名逐字沿用 |
| skills 加载 | buildSystemPrompt 已显式列必读清单（ws-bridge.ts:307-313）+ agent Read 自取；必要时首回合自动注入 | 机制等价，强制力略降（R2 有对策） |
| agent 循环（模型↔工具迭代） | AgentLoop.runTurn | 等价 |
| 上下文压缩 | compact.ts（一期截断/二期结构压缩） | CLI 内部压缩不可见不可控；自实现反而可控 |
| 会话恢复（--resume） | agent-session.json 还原 | 更快更可靠（无 stale session 问题） |
| 权限系统 | 本来就用 --dangerously-skip-permissions 绕过 | 无损失；反而加了路径断言加固 |
| 多模态看图 | Read→ImageBlock→vision 模型（评审全程 vision，不热切换） | 协议标准能力；V4 Vision/Kimi/GLM 视觉实测为验收项 |
| WebSearch | **Phase 1 接 Kimi $web_search**；三期 Tavily/Bing 增强 | research 绑死 Kimi 路由 |

**结论**：能力不来自 CLI，来自"模型 + 工具循环 + skills 内容"。前两者自实现，skills 内容原样保留。唯一的真实变量是**模型本身的 agentic 素质**——这正是 Phase 1 A/B 对比要验证的。
