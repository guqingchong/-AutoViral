/**
 * 用户显式参数块(2026-08-28 批次5.8,v2-M1):最高优先级事实源。
 * 创作侧与评审侧共用——评审不得以通用规则压低用户显式指定的参数。
 *
 * 2026-08-31 从 api.ts 抽为独立模块:ws-bridge 系统 prompt 也需要注入
 * (实测发现 startWorkSession 路径漏注,agent 把用户显式 300s 当成该压到 180s 的对象);
 * api.ts 与 ws-bridge.ts 互相 import 会成环,故落中立模块。
 */

import type { Work } from "../work-store.js";

export function buildExplicitParamsBlock(work: Work): string {
  const params = work.explicitParams;
  if (!params || Object.keys(params).length === 0) return "";
  const lines: string[] = ["## 用户显式要求(最高优先级事实源,优先级高于一切通用规则与预设)"];
  for (const [k, v] of Object.entries(params)) {
    if (k === "duration") {
      lines.push(`- 时长: 用户明确要求约 ${v} 秒。创作与评审都必须以该值为准绳——成片时长达标于此值即合格,禁止套用"短视频 ≤3 分钟"的通用规则判 critical/major。`);
    } else {
      lines.push(`- ${k}: ${v}(用户显式指定,不得以通用规则压低)`);
    }
  }
  return lines.join("\n");
}
