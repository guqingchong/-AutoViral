/**
 * agent 会话持久化（2026-08-17 Phase 1）。
 * 设计文档：docs/desigen/01 §4.2
 *
 * agent-session.json 是 loop 的权威状态（chat.jsonl 无法还原 LLM messages：
 * tool_use input 被字符串化、tool_use_id 配对丢失、无 system）。
 * chat.jsonl/chat.json/steps 摘要三层维持现状双写（由 ws-compat 负责），此处只管权威层。
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../config.js";
import type { AgentMessage } from "../llm/types.js";

const SESSION_VERSION = 1;

export interface AgentSessionState {
  version: number;
  sessionId: string;
  model: string;
  messages: AgentMessage[];
  pendingAskToolUseId?: string | null;
  createdAt: string;
  updatedAt: string;
}

function sessionPath(workId: string): string {
  return join(dataDir, "works", workId, "agent-session.json");
}

/** 读取会话状态；文件缺失/损坏/版本不符 → 返回 null（调用方全新开 loop，限 1 次） */
export async function loadAgentSession(workId: string): Promise<AgentSessionState | null> {
  try {
    const raw = await readFile(sessionPath(workId), "utf-8");
    const parsed = JSON.parse(raw) as AgentSessionState;
    if (parsed.version !== SESSION_VERSION || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 原子写（tmp + rename），防 crash 写出半个文件 */
export async function saveAgentSession(workId: string, state: AgentSessionState): Promise<void> {
  const path = sessionPath(workId);
  await mkdir(join(dataDir, "works", workId), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), "utf-8");
  await rename(tmp, path);
}

/** 3 秒防抖增量保存（复刻 ws-bridge.ts:189-200 模式） */
export function createDebouncedSaver(workId: string, getState: () => AgentSessionState): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      saveAgentSession(workId, getState()).catch(() => {});
    }, 3000);
  };
}
