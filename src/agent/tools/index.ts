/**
 * 工具执行器注册表（2026-08-17 LLM 直连架构 Phase 1）。
 * 设计文档：docs/desigen/01 §4.3
 *
 * 工具名逐字沿用 CLI 命名（Read/Write/Edit/Glob/Grep/Bash/WebSearch/AskUserQuestion），
 * system prompt 与 skills 全部按这些名字写成。
 */

import type { ContentBlock, ToolDef } from "../../llm/types.js";
import { readExecutor } from "./read.js";
import { writeExecutor } from "./write.js";
import { editExecutor } from "./edit.js";
import { globExecutor } from "./glob.js";
import { grepExecutor } from "./grep.js";
import { bashExecutor } from "./bash.js";
import { askUserQuestionExecutor } from "./ask-user.js";

export interface ToolContext {
  workDir: string;
  signal?: AbortSignal;
  /** 长任务进度心跳(2026-08-28 批次4.1):工具执行期间周期性回传输出尾部,UI 据此区分"慢"与"死" */
  onProgress?: (text: string) => void;
}

export interface ToolExecutor {
  def: ToolDef;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string | ContentBlock[]>;
}

export type ToolExecutorMap = Record<string, ToolExecutor>;

export interface ToolBuildOptions {
  /** bash 命令黑名单正则（config.llm.guard.bashBlocklist） */
  bashBlocklist?: string[];
  /** 是否注册 WebSearch（Kimi $web_search 注入时传 true） */
  enableWebSearch?: boolean;
}

/** creator 会话全量工具集 */
export function buildCreatorTools(opts: ToolBuildOptions = {}): ToolExecutorMap {
  const list: ToolExecutor[] = [
    readExecutor,
    writeExecutor,
    editExecutor,
    globExecutor,
    grepExecutor,
    bashExecutor(opts.bashBlocklist),
    // 2026-08-28 批次2.6:激活"agent 主动问用户"通道(loop 配对回填+前端渲染早已就位)
    askUserQuestionExecutor,
  ];
  const map: ToolExecutorMap = {};
  for (const e of list) map[e.def.name] = e;
  return map;
}

/** 评审会话只读子集（Read/Glob/Grep/Bash） */
export function buildEvaluatorTools(opts: ToolBuildOptions = {}): ToolExecutorMap {
  const list: ToolExecutor[] = [readExecutor, globExecutor, grepExecutor, bashExecutor(opts.bashBlocklist)];
  const map: ToolExecutorMap = {};
  for (const e of list) map[e.def.name] = e;
  return map;
}
