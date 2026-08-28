/**
 * 进度事件总线(2026-08-28 批次4.3)。
 *
 * 背景(病根 13 静默清单):耗时大头都在 WS 事件管道之外裸奔——成片渲染进度只落库、
 * AI 生视频轮询零事件、配额冷却只 console.log。services 层无法直接引用 wsBridge
 * (会成 import 环),故设此总线:server 启动时由 api.ts 注册广播器,services 只管发。
 *
 * 纪律:本总线事件**不得**用于更新会话 lastActivityAt(传输层活性≠ loop 进展,
 * 灌活会让 watchdog 全盲)——目前仅广播给前端展示,不进活性判定。
 */

export interface ProgressEvent {
  workId?: string;
  kind: "render" | "generation" | "publish" | "system";
  text: string;
  percent?: number;
}

type Broadcaster = (ev: ProgressEvent) => void;

let broadcaster: Broadcaster | null = null;

export function registerProgressBroadcaster(fn: Broadcaster): void {
  broadcaster = fn;
}

export function broadcastProgress(ev: ProgressEvent): void {
  try {
    broadcaster?.(ev);
  } catch { /* 广播失败不阻断业务 */ }
}
