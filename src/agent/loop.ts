/**
 * 进程内 agent loop（2026-08-17 LLM 直连架构 Phase 1 核心）。
 * 设计文档：docs/desigen/01 §4.1
 *
 * runTurn(userText) = 一条用户消息的全部工具迭代——与 CLI `-p` 回合粒度对齐，
 * runner/evaluator/waitForCreatorIdle 的既有逻辑无需重设计。
 *
 * AskUserQuestion（配对回填设计，DeepSeek 审查修订）：
 * 发 tool_use 事件 → 记录 pendingAskToolUseId → 回合结束（awaiting_user）；
 * 用户下一条输入作为该 tool_use 的 tool_result 回填（配对完整，语义无损）；
 * 若用户发了无关新指令，则降级为新 user 消息并补一条"用户未回答"的 tool_result 保持配对合法。
 */

import type {
  AgentMessage,
  ContentBlock,
  LlmProvider,
  TextBlock,
  ToolDef,
  ToolResultBlock,
  ToolUseBlock,
} from "../llm/types.js";
import type { ToolExecutorMap } from "./tools/index.js";
import { maybeCompact } from "./compact.js";
import { QuotaExhaustedError, isQuotaErrorText, reportQuotaExhausted } from "../services/quota-guard.js";

export type LoopState = "idle" | "running" | "aborted";

export interface LoopEvent {
  type:
    | "text_delta"
    | "thinking_delta"
    | "tool_use"
    | "tool_result"
    | "turn_start"
    | "turn_complete"
    | "vision_route"
    | "error";
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  resultText?: string;
  stopReason?: string;
  error?: string;
}

export interface AgentLoopDeps {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  tools: ToolExecutorMap;
  /** 服务端执行的内置工具(如 Kimi $web_search)——随请求下发,调用时按平台协议回填 arguments */
  builtinTools?: ToolDef[];
  /** 视觉路由(P2-T1):消息含图片时该回合改用此 provider+model(评审看图;glm-4v 实测不支持 tools,优先 kimi) */
  visionProvider?: LlmProvider;
  visionModel?: string;
  workDir: string;
  onLoopEvent: (ev: LoopEvent) => void;
  guard?: {
    maxStepsPerTurn?: number;
    maxTurnMinutes?: number;
  };
  /** 结构压缩阈值(tokens 估算,默认 120k)——测试可传小值 */
  compactThreshold?: number;
  /** 用量记账上下文(P3-T2):挂上后每次 chatStream 的 usage 事件落 llm_usage 并做日预算熔断 */
  usageContext?: { workId?: string; stage?: string };
}

export class LoopGuardError extends Error {}

/**
 * tool_use/tool_result 配对不变量:每个 assistant 的 tool_use 必须在紧随的 user 消息里
 * 有配对 tool_result;缺失则合成错误结果补齐(就地修改)。压缩切口/回合中断/AskUserQuestion
 * 提前 return 都可能制造孤儿 tool_calls,OpenAI 兼容端点对孤儿一律 400。
 */
export function ensureToolPairing(messages: AgentMessage[]): void {
  // 前置清洗(2026-08-26 实证):回合被杀死在"只有 thinking 尚未产出 text/tool_use"
  // 的时点,留下纯 thinking 的 assistant 消息——OpenAI 协议序列化后
  // content/tool_calls 全空,每次请求都 400(Invalid assistant message),
  // auto_continue 15 次全灭。这类消息是被截断的残片,直接剔除。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const hasPayload = m.content.some((b) =>
      (b.type === "text" && b.text.trim().length > 0) || b.type === "tool_use");
    if (!hasPayload) {
      console.warn(`[agent-loop] 清洗剔除:msg[${i}] 纯 thinking/空 assistant 消息(回合截断残片)`);
      messages.splice(i, 1);
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const uses = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (!uses.length) continue;
    const next = messages[i + 1];
    const results = next?.role === "user"
      ? next.content.filter((b): b is ToolResultBlock => b.type === "tool_result")
      : [];
    const missing = uses.filter((u) => !results.some((r) => r.tool_use_id === u.id));
    if (!missing.length) continue;
    console.warn(`[agent-loop] 配对修复:${missing.length} 个孤儿 tool_use 补合成结果`);
    const synth: ToolResultBlock[] = missing.map((u) => ({
      type: "tool_result",
      tool_use_id: u.id,
      name: u.name,
      content: "错误:该工具调用未执行(回合中断或上下文编辑导致配对丢失),如需请重新发起",
      is_error: true,
    }));
    if (next?.role === "user") next.content.push(...synth);
    else messages.splice(i + 1, 0, { role: "user", content: synth });
  }
}

export class AgentLoop {
  messages: AgentMessage[];
  state: LoopState = "idle";
  private abort?: AbortController;
  /** AskUserQuestion 配对回填：记录待答 tool_use id */
  pendingAskToolUseId: string | null = null;

  constructor(
    private deps: AgentLoopDeps,
    restored?: AgentMessage[],
  ) {
    this.messages = restored ?? [];
  }

  /** usage 事件落账(P3-T2) + 日预算熔断。异步执行,不阻塞主循环;失败仅告警 */
  private recordUsage(ev: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }, useVision: boolean): void {
    const ctx = this.deps.usageContext;
    if (!ctx) return;
    const provider = useVision && this.deps.visionProvider ? this.deps.visionProvider : this.deps.provider;
    const model = useVision && this.deps.visionModel ? this.deps.visionModel : this.deps.model;
    void (async () => {
      try {
        const { loadConfig } = await import("../config.js");
        const { recordUsage, enforceDailyBudget } = await import("../services/llm-usage.js");
        const { listQueue, setStatus } = await import("../db/work-queue-repo.js");
        const config = await loadConfig();
        recordUsage(config, {
          workId: ctx.workId, stage: ctx.stage, provider: provider.name, model,
          inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens,
        });
        enforceDailyBudget(config, () => {
          let n = 0;
          for (const item of listQueue()) {
            // 2026-08-19 P0:熔断暂停带 budget 原因——日切后 runner 据此批量恢复,
            // 且与用户手动暂停/配额暂停区分,互不误恢复
            if (item.status === "running" || item.status === "queued") { setStatus(item.workId, "paused", { pausedReason: "budget" }); n++; }
          }
          return n;
        });
      } catch (err) {
        console.warn("[agent-loop] usage 记账失败(不阻断主流程):", err instanceof Error ? err.message : err);
      }
    })();
  }

  abortTurn(): void {
    this.state = "aborted";
    this.abort?.abort();
  }

  /** 一个用户回合：返回最终文本（等价 CLI 的 result 事件语义） */
  async runTurn(userText: string): Promise<{ resultText: string; stopReason: string }> {
    if (this.state === "running") throw new Error("loop 正在运行中，不允许并发 runTurn");
    this.state = "running";
    this.abort = new AbortController();
    const maxSteps = this.deps.guard?.maxStepsPerTurn ?? 200;
    const deadline = Date.now() + (this.deps.guard?.maxTurnMinutes ?? 30) * 60_000;
    let lastSig = "";
    let repeatCount = 0;

    // AskUserQuestion 配对回填：用户答案作为 pending tool_use 的 tool_result
    if (this.pendingAskToolUseId) {
      const askId = this.pendingAskToolUseId;
      this.pendingAskToolUseId = null;
      this.messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: askId, content: userText }],
      });
    } else {
      this.messages.push({ role: "user", content: [{ type: "text", text: userText }] });
    }

    this.deps.onLoopEvent({ type: "turn_start" });
    try {
      for (let step = 0; ; step++) {
        if (step > maxSteps) throw new LoopGuardError(`回合工具步数超过 ${maxSteps}，判定死循环`);
        if (Date.now() > deadline) throw new LoopGuardError("回合超时（maxTurnMinutes）");
        if ((this.state as LoopState) === "aborted") {
          return { resultText: "", stopReason: "aborted" };
        }

        // 结构压缩(P2-T2):估算超阈值先把中段换确定性摘要再发,防上下文无限膨胀
        const compacted = await maybeCompact(this.messages, { workDir: this.deps.workDir, threshold: this.deps.compactThreshold });
        if (compacted.compacted) this.messages = compacted.messages;

        // 配对不变量(2026-08-17 live 评审 400 实证):任何 assistant tool_use 必须在紧随的
        // user 消息里有配对 tool_result——回合中断/压缩切口/提前 return 都可能留下孤儿,
        // OpenAI 协议直接 400。缺什么补什么(合成错误结果),发送前永保合法。
        ensureToolPairing(this.messages);

        // 视觉路由:最近消息出现新图片(Read 读图/工具返回图)且配置了视觉模型 → 本回合走视觉模型。
        // 只看最近 4 条:更早的图片已被视觉回合的文字描述沉淀,不因此永久粘滞在视觉模型上;
        // 非视觉回合的图片一律降格为文本占位(DeepSeek 文本模型见 image_url 直接 400——2026-08-17 live)
        const recent = this.messages.slice(-4);
        const hasImage = recent.some((m) =>
          m.content.some((b) =>
            b.type === "image" ||
            (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((x) => x.type === "image"))));
        const useVision = hasImage && !!this.deps.visionProvider && !!this.deps.visionModel;
        if (useVision) {
          console.log(`[agent-loop] vision route: ${this.deps.visionModel}(图片进请求)`);
          this.deps.onLoopEvent({ type: "vision_route", text: this.deps.visionModel });
        }

        const { stopReason, assistant } = await (useVision ? this.deps.visionProvider! : this.deps.provider).chatStream(
          {
            model: useVision ? this.deps.visionModel! : this.deps.model,
            allowImages: useVision,
            system: this.deps.systemPrompt,
            messages: this.messages,
            tools: [
              ...Object.values(this.deps.tools).map((t) => t.def),
              ...(this.deps.builtinTools ?? []),
            ],
            maxTokens: 8192,
            signal: this.abort.signal,
          },
          (ev) => {
            if (ev.type === "text_delta") this.deps.onLoopEvent({ type: "text_delta", text: ev.text });
            else if (ev.type === "thinking_delta") this.deps.onLoopEvent({ type: "thinking_delta", text: ev.text });
            else if (ev.type === "usage") this.recordUsage(ev, useVision);
          },
        );

        this.messages.push(assistant);

        if (stopReason !== "tool_use") {
          const resultText = assistant.content
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          this.deps.onLoopEvent({ type: "turn_complete", resultText, stopReason });
          return { resultText, stopReason };
        }

        // 执行工具调用
        const toolUses = assistant.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
        const results: ToolResultBlock[] = [];
        for (const tu of toolUses) {
          this.deps.onLoopEvent({ type: "tool_use", toolName: tu.name, toolInput: tu.input });

          // 同工具同参 3 连检测
          const sig = `${tu.name}:${JSON.stringify(tu.input)}`;
          repeatCount = sig === lastSig ? repeatCount + 1 : 0;
          lastSig = sig;
          if (repeatCount >= 3) throw new LoopGuardError(`同一工具同一参数连续 ${repeatCount + 1} 次：${tu.name}`);

          if (tu.name === "AskUserQuestion") {
            // 配对回填：结束回合，等待用户下条输入作为本 tool_use 的 tool_result
            this.pendingAskToolUseId = tu.id;
            const resultText = assistant.content
              .filter((b): b is TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("");
            this.deps.onLoopEvent({ type: "turn_complete", resultText, stopReason: "awaiting_user" });
            return { resultText, stopReason: "awaiting_user" };
          }

          // 服务端执行的内置工具(Kimi $web_search 等):本地无实现,按 moonshot 协议把
          // arguments 逐字回填为 tool 消息——平台在下一轮请求时执行搜索并注入结果(2026-08-17 实测)
          if (tu.builtin || this.deps.builtinTools?.some((t) => t.name === tu.name)) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              name: tu.name,
              content: tu.rawArguments ?? JSON.stringify(tu.input),
            });
            this.deps.onLoopEvent({ type: "tool_result", toolName: tu.name, toolResult: "[内置工具:平台服务端执行]" });
            continue;
          }

          const executor = this.deps.tools[tu.name];
          let resultText: string;
          let isError = false;
          if (!executor) {
            resultText = `错误：未知工具 ${tu.name}`;
            isError = true;
          } else {
            try {
              const out = await executor.execute(tu.input, { workDir: this.deps.workDir, signal: this.abort.signal });
              resultText = typeof out === "string" ? out : "[图片内容已展示]";
              if (typeof out !== "string") {
                // 图片等多模态结果：content 直接带块
                results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
                this.deps.onLoopEvent({ type: "tool_result", toolName: tu.name, toolResult: "[图片]" });
                continue;
              }
            } catch (err) {
              resultText = `错误：${(err as Error).message}`;
              isError = true;
            }
          }
          this.deps.onLoopEvent({ type: "tool_result", toolName: tu.name, toolResult: resultText.slice(0, 500) });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: resultText, is_error: isError });
        }
        this.messages.push({ role: "user", content: results as ContentBlock[] });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A3 配额防护:配额类错误冒泡到全局状态,work-queue 据此暂停批量(不再反复恢复撞墙)
      if (err instanceof QuotaExhaustedError || isQuotaErrorText(message)) {
        reportQuotaExhausted("api-loop");
      }
      this.deps.onLoopEvent({ type: "error", error: message });
      throw err;
    } finally {
      if ((this.state as LoopState) !== "aborted") this.state = "idle";
    }
  }
}
