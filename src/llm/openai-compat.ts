/**
 * OpenAI 兼容协议 LLM provider（2026-08-16 架构改造 Phase 0）。
 * 覆盖 DeepSeek / Kimi(Coding Plan) / GLM(Coding Plan) 三家，同一实现按配置切换。
 * 设计文档：docs/desigen/01-LLM直连架构-详细设计方案.md §3.2
 *
 * 关键行为：
 * - 流式 tool_calls 的 function.arguments 分片累积，完整后一次性发 tool_use 事件
 *   （与 CLI 按完整 block 下发的行为对齐，ws-compat 依赖这一粒度）
 * - 消息纪律：system+tools 恒定在前、messages 只追加不改写 → 命中自动前缀缓存
 * - usage 经 stream_options.include_usage 取得，cacheReadTokens ← prompt_cache_hit_tokens
 */

import type {
  AgentMessage,
  ChatRequest,
  ContentBlock,
  ImageBlock,
  LlmProvider,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";
import { noRetry, withRetry } from "./retry.js";
import { extractJsonFromText, JSON_OUTPUT_DISCIPLINE } from "./json-extract.js";
import { QuotaExhaustedError, isQuotaErrorText, reportQuotaSuccess } from "../services/quota-guard.js";

/** SSE 停滞超时(2026-08-28 批次1.1):provider 保持连接但停发数据时,此前会永久挂起
 *  (5e3 评审器僵死 14h 的技术根因之一)。
 *  分段计时:首 delta(TTFB,含排队/预填充/非流式思考缓冲,GLM-5.3 thinking 不可关闭可长达数分钟)
 *  与流中停滞(thinking 模式下 reasoning_delta 持续流动,可用较紧阈值)分别设限。 */
export class StallTimeoutError extends Error {
  readonly phase: "first_delta" | "mid_stream";
  constructor(phase: "first_delta" | "mid_stream", timeoutMs: number) {
    super(`LLM SSE 停滞超时(${phase === "first_delta" ? "首 delta" : "流中"},${Math.round(timeoutMs / 1000)}s 无数据)`);
    this.name = "StallTimeoutError";
    this.phase = phase;
  }
}
const FIRST_DELTA_TIMEOUT_MS = 180_000;
const MID_STREAM_STALL_TIMEOUT_MS = 120_000;

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** AgentMessage → OpenAI messages 数组。builtinTools:当前请求挂载的内置工具名——
 *  历史里的 builtin tool_call 仅当本会话仍挂载该内置工具时才按 builtin_function 序列化,
 *  否则降级为普通 function(跨 provider 恢复会话时对方方言不认识 builtin_function,
 *  2026-08-17 实测 deepseek 400:unknown variant) */
function toOpenAiMessages(system: string, messages: AgentMessage[], builtinTools: Set<string> = new Set(), allowImages = true, passReasoningBack = false): Record<string, unknown>[] {
  // 空 system 不下发(2026-08-18 实测 kimi 400: the message at position 0 with role 'system' must not be empty)
  const out: Record<string, unknown>[] = system.trim() ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = m.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: b.builtin && builtinTools.has(b.name) ? "builtin_function" : "function",
          // builtin 回填逐字用原始 arguments(moonshot 协议:平台按 search_id 执行并注入结果)
          function: { name: b.name, arguments: b.rawArguments ?? JSON.stringify(b.input) },
        }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      // thinking 模式供应商(Kimi/DeepSeek-v4)：多轮回填必须带 reasoning_content，否则 400
      // （2026-08-18 验收片评审 deepseek-v4-pro 长链工具回合实测踩中）；由 provider 级开关控制
      if (passReasoningBack) {
        const reasoning = m.content
          .filter((b): b is ThinkingBlock => b.type === "thinking")
          .map((b) => b.thinking)
          .join("");
        if (reasoning) msg.reasoning_content = reasoning;
      }
      out.push(msg);
    } else {
      // user 消息：可能含 tool_result / text / image 混合
      const toolResults = m.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
      const rest = m.content.filter((b) => b.type !== "tool_result");
      const toolImages: ImageBlock[] = [];
      for (const tr of toolResults) {
        const contentArr = typeof tr.content === "string" ? null : tr.content;
        out.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          ...(tr.name ? { name: tr.name } : {}),
          content: contentArr ? flattenBlocks(contentArr) : (tr.content as string),
        });
        // tool 角色消息不能携带图片(OpenAI 协议)——先收集,全部 tool 消息发完后统一带走。
        // 关键:tool 消息必须紧跟 assistant tool_calls 且连续——多工具回合若逐条
        // 穿插 user 图片消息,第二个 tool_call_id 就被判无响应 400(2026-08-17 live 踩中)
        if (contentArr) toolImages.push(...contentArr.filter((b): b is ImageBlock => b.type === "image"));
      }
      if (toolImages.length) {
        out.push(
          allowImages
            ? {
                role: "user",
                content: [
                  { type: "text", text: "[上述工具调用返回的图片内容]" },
                  ...toolImages.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })),
                ],
              }
            : { role: "user", content: "[上述工具调用返回了图片内容;当前模型无视觉能力,图片已省略]" },
        );
      }
      if (rest.length) {
        out.push({ role: "user", content: toOpenAiUserContent(rest, allowImages) });
      }
    }
  }
  return out;
}

function flattenBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return "[图片]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAiUserContent(blocks: ContentBlock[], allowImages = true): unknown {
  const hasImage = allowImages && blocks.some((b) => b.type === "image");
  if (!hasImage) return flattenBlocks(blocks);
  return blocks.map((b) => {
    if (b.type === "image") {
      const img = b as ImageBlock;
      return { type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } };
    }
    if (b.type === "text") return { type: "text", text: (b as TextBlock).text };
    if (b.type === "thinking") return { type: "text", text: (b as ThinkingBlock).thinking };
    return { type: "text", text: "" };
  });
}

/** ToolDef(anthropic 风格 input_schema) → OpenAI function 格式;builtin 工具映射为 builtin_function(平台服务端执行) */
function toOpenAiTools(tools: ChatRequest["tools"]): Record<string, unknown>[] {
  return tools.map((t) =>
    t.builtin
      ? { type: "builtin_function", function: { name: t.name } }
      : { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } },
  );
}

export class OpenAICompatProvider implements LlmProvider {
  readonly protocol = "openai" as const;
  constructor(
    readonly name: string,
    private opts: { baseUrl: string; apiKey: string; passReasoningBack?: boolean },
  ) {}

  async chatStream(
    req: ChatRequest,
    onEvent: (ev: StreamEvent) => void,
  ): Promise<{ stopReason: string; assistant: AgentMessage }> {
    // 首个 delta 到达前的失败可整体重试；已开始输出则直接抛（防重复输出混入）
    let firstDeltaSeen = false;
    const guardedOnEvent = (ev: StreamEvent) => {
      if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "tool_use") firstDeltaSeen = true;
      onEvent(ev);
    };
    return withRetry(async () => {
      try {
        return await this.doChatStream(req, guardedOnEvent);
      } catch (err) {
        if (firstDeltaSeen) throw noRetry(err as Error);
        throw err;
      }
    });
  }

  private async doChatStream(
    req: ChatRequest,
    onEvent: (ev: StreamEvent) => void,
  ): Promise<{ stopReason: string; assistant: AgentMessage }> {
    // 停滞超时控制器:与 req.signal(用户/回合中止)独立,合并进 fetch。
    // 纪律(2026-08-28 论证):停滞必须显式 throw StallTimeoutError——
    // 若只中断读循环,会落入下方"部分输出组装成正常消息返回"的路径造成静默截断。
    const stallCtrl = new AbortController();
    let stallPhase: "first_delta" | "mid_stream" = "first_delta";
    let stallTimer: NodeJS.Timeout | undefined;
    const resetStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => stallCtrl.abort(),
        stallPhase === "first_delta" ? FIRST_DELTA_TIMEOUT_MS : MID_STREAM_STALL_TIMEOUT_MS,
      );
    };
    resetStallTimer();
    // 批次8.7 遥测:调用墙钟 + thinking 字符量(思考 token 此前无记账,96% 产出不可见)
    const callStart = Date.now();
    let thinkingChars = 0;
    const combinedSignal =
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([req.signal, stallCtrl.signal].filter(Boolean) as AbortSignal[])
        : (req.signal ?? stallCtrl.signal);

    // 请求体独立成变量:支持 max_tokens 超供应商上限时收敛重试(见下方 400 处理)
    const reqBody: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.system, req.messages, new Set(req.tools.filter((t) => t.builtin).map((t) => t.name)), req.allowImages !== false, this.opts.passReasoningBack === true),
      tools: req.tools.length ? toOpenAiTools(req.tools) : undefined,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    const postOnce = async (): Promise<Response> => {
      try {
        return await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(reqBody),
          signal: combinedSignal,
        });
      } catch (err) {
        // 停滞中止(TTFB 阶段)区别于用户中止:转专用错误,便于日志/重试语义区分
        if (stallCtrl.signal.aborted) throw new StallTimeoutError(stallPhase, FIRST_DELTA_TIMEOUT_MS);
        // 用户/回合中止不可重试(否则 abort 后还会空转 3 次退避 ~50s)
        if (req.signal?.aborted) throw noRetry(err as Error);
        throw err;
      }
    };
    let res: Response = await postOnce();
    // 2026-08-31 实测实证:deepseek-v4-flash-vision-exp 等模型 max_tokens 上限仅 2048
    // (错误码 1210 "限制数值范围[1,2048]"),loop 层提到 32768 后评审三轮 400 全灭,
    // a4d 成片终审被冤杀。400 且报文指明上限时自动收敛到上限重试一次——
    // 比逐模型维护上限表皮实(新模型接入即自愈)。
    if (!res.ok && res.status === 400) {
      const peek = await res.clone().text().catch(() => "");
      if (/max_tokens/i.test(peek)) {
        const capMatch = peek.match(/\[\s*1\s*,\s*(\d+)\s*\]/)
          ?? peek.match(/(?:上限|最大|不得超过|maximum|limit)\D{0,12}(\d{3,6})/i);
        const cap = capMatch ? Number(capMatch[1]) : 0;
        if (cap > 0 && Number(reqBody.max_tokens) > cap) {
          console.warn(`[llm] max_tokens ${reqBody.max_tokens} 超出 ${this.name}/${req.model} 上限 ${cap},收敛后重试一次`);
          reqBody.max_tokens = cap;
          res = await postOnce();
        }
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 诊断留证(2026-08-18 kimi reasoning_content 400 排查):400 时落盘请求体供复盘
      if (res.status === 400) {
        try {
          const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const dir = join(homedir(), ".autoviral", "logs");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const msgs = toOpenAiMessages(req.system, req.messages, new Set(req.tools.filter((t) => t.builtin).map((t) => t.name)), req.allowImages !== false, this.opts.passReasoningBack === true);
          writeFileSync(join(dir, "last-400-request.json"), JSON.stringify({
            provider: this.name, model: req.model, at: new Date().toISOString(),
            error: body.slice(0, 500),
            messageSummary: msgs.map((m: any) => ({
              role: m.role,
              hasReasoning: typeof m.reasoning_content === "string" && m.reasoning_content.length > 0,
              contentLen: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length,
              toolCalls: (m.tool_calls ?? []).length,
            })),
          }, null, 2));
        } catch { /* 诊断失败不阻断主流程 */ }
      }
      // 配额类错误单列:不可重试 + 可被 loop/work-queue 识别冒泡(A3 配额防护)
      if (isQuotaErrorText(body)) {
        throw noRetry(new QuotaExhaustedError(`LLM API ${res.status} 配额耗尽: ${body.slice(0, 200)}`));
      }
      const err = new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw noRetry(err);
      throw err;
    }
    reportQuotaSuccess(); // 任一调用成功即解除配额冷却(试探成功的正信号)
    if (!res.body) throw new Error("LLM API 响应无 body");

    // SSE 解析：跨 chunk 断行安全
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stopReason = "end_turn";
    const textParts: string[] = [];
    const thinkParts: string[] = [];
    // tool_calls 累积器：index → {id, name, arguments, 是否平台内置工具}
    const tcAcc = new Map<number, { id: string; name: string; args: string; builtin: boolean }>();
    let emittedStop = false;

    const flushToolCalls = (): void => {
      for (const [, tc] of [...tcAcc.entries()].sort((a, b) => a[0] - b[0])) {
        let input: Record<string, unknown> = {};
        try {
          input = tc.args ? JSON.parse(tc.args) : {};
        } catch {
          input = { _raw: tc.args };
        }
        onEvent({
          type: "tool_use",
          block: {
            type: "tool_use", id: tc.id || `call_${tcAcc.size}`, name: tc.name, input,
            ...(tc.builtin ? { builtin: true, rawArguments: tc.args } : {}),
          },
        });
      }
    };

    const handleData = (json: string): void => {
      let chunk: any;
      try {
        chunk = JSON.parse(json);
      } catch {
        return; // 半行/心跳，忽略
      }
      // 首个有意义 delta 到达 → 切换为流中停滞阈值(更紧)
      if (stallPhase === "first_delta" && (chunk.usage || chunk.choices?.[0])) {
        stallPhase = "mid_stream";
      }
      if (chunk.usage) {
        onEvent({
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_cache_hit_tokens ?? undefined,
          latencyMs: Date.now() - callStart,
          // thinking token 估算:字符数 / 1.5(中英混合粗估,用于占比观测而非精确计费)
          thinkingTokens: thinkingChars ? Math.ceil(thinkingChars / 1.5) : undefined,
        });
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        thinkParts.push(delta.reasoning_content);
        thinkingChars += delta.reasoning_content.length;
        onEvent({ type: "thinking_delta", text: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        textParts.push(delta.content);
        onEvent({ type: "text_delta", text: delta.content });
      }
      for (const tc of (delta.tool_calls ?? []) as OpenAiToolCallDelta[]) {
        const acc = tcAcc.get(tc.index) ?? { id: "", name: "", args: "", builtin: false };
        if (tc.id) acc.id = tc.id;
        if (tc.type === "builtin_function") acc.builtin = true;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        tcAcc.set(tc.index, acc);
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason === "stop" ? "end_turn"
          : choice.finish_reason === "tool_calls" ? "tool_use"
          : choice.finish_reason === "length" ? "max_tokens"
          : choice.finish_reason;
        if (stopReason === "tool_use" && !emittedStop) {
          emittedStop = true;
          flushToolCalls();
        }
        onEvent({ type: "message_stop", stopReason: stopReason as never });
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStallTimer(); // 任何数据块到达都证明连接活着
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          handleData(payload);
        }
      }
    } catch (err) {
      // 流中停滞中止 → 显式抛 StallTimeoutError(纪律:绝不落入下方部分输出正常返回路径)
      if (stallCtrl.signal.aborted) {
        throw new StallTimeoutError(stallPhase, stallPhase === "first_delta" ? FIRST_DELTA_TIMEOUT_MS : MID_STREAM_STALL_TIMEOUT_MS);
      }
      if (req.signal?.aborted) throw noRetry(err as Error);
      throw err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    if (req.signal?.aborted) {
      onEvent({ type: "message_stop", stopReason: "aborted" });
      stopReason = "aborted";
    }

    // 组装 assistant 消息（供 loop 直接入 messages）
    const blocks: ContentBlock[] = [];
    if (thinkParts.length) blocks.push({ type: "thinking", thinking: thinkParts.join("") });
    if (textParts.length) blocks.push({ type: "text", text: textParts.join("") });
    for (const [, tc] of [...tcAcc.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        input = { _raw: tc.args };
      }
      blocks.push({
        type: "tool_use", id: tc.id, name: tc.name, input,
        ...(tc.builtin ? { builtin: true, rawArguments: tc.args } : {}),
      });
    }
    return { stopReason, assistant: { role: "assistant", content: blocks } };
  }

  async chatJson<T>(prompt: string, opts: { model: string; timeoutMs?: number; maxAttempts?: number; usageStage?: string; usageWorkId?: string }): Promise<T> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
      const callStart = Date.now();
      try {
        const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [{ role: "user", content: prompt + JSON_OUTPUT_DISCIPLINE }],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const err = new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw noRetry(err);
          throw err;
        }
        const data = (await res.json()) as any;
        // 直连记账(2026-08-19 P1):非流式 chatJson 此前全漏账,日预算熔断失真
        const u = data.usage;
        if (u) {
          const { recordUsageAsync } = await import("../services/llm-usage.js");
          recordUsageAsync({
            stage: opts.usageStage, workId: opts.usageWorkId,
            provider: this.name, model: opts.model,
            inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0,
            cacheReadTokens: u.prompt_cache_hit_tokens,
            latencyMs: Date.now() - callStart,
          });
        }
        const text: string = data.choices?.[0]?.message?.content ?? "";
        const extracted = extractJsonFromText(text);
        if (extracted === undefined || extracted === null) {
          throw new Error(`chatJson 无法从响应提取 JSON: ${text.slice(0, 200)}`);
        }
        return extracted as T;
      } finally {
        clearTimeout(timer);
      }
    }, { maxAttempts: opts.maxAttempts ?? 3 });
  }
}
