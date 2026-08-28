/**
 * 统一失败通道(2026-08-28 批次7.5,v2-M6)。
 *
 * 原则:失败必须显式可见,禁止只记日志。所有"catch 后 console.error/吞掉"的站点
 * 改用 failVisible:落错误日志 + 进度总线广播(作品页/全局通知,批次 4.6 已接)。
 * fatal=true 表示作品级终止(调用方应同时落 failed 状态)。
 */

import { log } from "../logger.js";
import { broadcastProgress } from "./progress-events.js";

export function failVisible(
  scope: { workId?: string; stage?: string },
  reason: string,
  opts: { fatal?: boolean } = {},
): void {
  log("error", "server", opts.fatal ? "fail_visible_fatal" : "fail_visible", scope.workId ?? "-", {
    stage: scope.stage,
    reason: reason.slice(0, 300),
  });
  broadcastProgress({
    workId: scope.workId,
    kind: "system",
    text: `❌ ${scope.stage ? `${scope.stage} ` : ""}失败:${reason.slice(0, 120)}`,
  });
}
