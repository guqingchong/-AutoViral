/**
 * LoopEvent → WS 事件兼容层（2026-08-17 Phase 1）。
 * 设计文档：docs/desigen/01 §4.5 映射表
 *
 * createLoopEventSink 返回的函数在构造 AgentLoop 时作为 onLoopEvent 传入，
 * 把 loop 事件翻译成与 CLI 时代逐字一致的 WS 事件 + ChatBlock 写入，
 * 前端（Studio.svelte）与 TestRunner 零感知。
 */

import type { ChatBlock, WsBridge, WsSession } from "../ws-bridge.js";
import type { LoopEvent } from "./loop.js";

const TEXT_BATCH_MS = 50;

export interface SinkOptions {
  /** 评审会话传 "evaluator"——前端用它区分评审输出 */
  source?: "creator" | "evaluator";
}

export function createLoopEventSink(session: WsSession, bridge: WsBridge, opts: SinkOptions = {}): (ev: LoopEvent) => void {
  const source = opts.source ?? "creator";
  let textBuf = "";
  let textTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkBuf = "";

  const now = () => new Date().toISOString();

  const flushText = (): void => {
    if (!textBuf) return;
    const text = textBuf;
    textBuf = "";
    bridge.pushBlock(
      session,
      { type: "text", text, source, timestamp: now() } as ChatBlock,
      "assistant_text",
      { workId: session.workId, text, source },
    );
  };
  const scheduleFlushText = (): void => {
    if (textTimer) return;
    textTimer = setTimeout(() => {
      textTimer = null;
      flushText();
    }, TEXT_BATCH_MS);
  };
  const flushThink = (): void => {
    if (!thinkBuf) return;
    const text = thinkBuf;
    thinkBuf = "";
    bridge.pushBlock(
      session,
      { type: "thinking", text, collapsed: true, source, timestamp: now() } as ChatBlock,
      "assistant_thinking",
      { workId: session.workId, text, source },
    );
  };

  return (ev: LoopEvent): void => {
    switch (ev.type) {
      case "turn_start":
        bridge.broadcastToBrowsers(session.workId, {
          event: "session_state",
          data: { workId: session.workId, connected: true, idle: false, cliSessionId: session.cliSessionId },
        });
        break;
      case "text_delta":
        flushThink();
        textBuf += ev.text ?? "";
        scheduleFlushText();
        break;
      case "thinking_delta":
        flushText();
        thinkBuf += ev.text ?? "";
        break;
      case "tool_use":
        flushThink();
        flushText();
        bridge.pushBlock(
          session,
          {
            type: "tool_use",
            toolName: ev.toolName,
            text: JSON.stringify(ev.toolInput ?? {}),
            source,
            timestamp: now(),
          } as ChatBlock,
          "tool_use",
          { workId: session.workId, name: ev.toolName, input: ev.toolInput ?? {}, source },
        );
        break;
      case "tool_result":
        flushThink();
        flushText();
        bridge.pushBlock(
          session,
          {
            type: "tool_result",
            text: ev.toolResult ?? "",
            collapsed: true,
            source,
            timestamp: now(),
          } as ChatBlock,
          "tool_result",
          { workId: session.workId, content: ev.toolResult ?? "", source },
        );
        break;
      case "turn_complete":
        flushThink();
        flushText();
        bridge.finalizeTurn(session, ev.resultText ?? "");
        break;
      case "vision_route":
        flushThink();
        flushText();
        bridge.pushBlock(
          session,
          { type: "thinking", text: `[视觉路由] 含图片回合 → ${ev.text}`, collapsed: true, source, timestamp: now() } as ChatBlock,
          "assistant_thinking",
          { workId: session.workId, text: `[视觉路由] 含图片回合 → ${ev.text}`, source },
        );
        break;
      case "error":
        flushThink();
        flushText();
        bridge.broadcastToBrowsers(session.workId, {
          event: "cli_exited",
          data: { workId: session.workId, code: 1, signal: null, error: ev.error },
        });
        break;
    }
  };
}
