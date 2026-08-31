/**
 * WsBridge — Agent Session Manager
 *
 * Bridges browser ↔ server ↔ Claude CLI via stdout pipe.
 * Each "work" gets a WsSession with CLI process, browser connections,
 * message history. CLI is spawned with `-p <prompt> --output-format stream-json
 * --verbose`. Multi-turn uses `--resume <sessionId> -p <newMessage>`.
 *
 * Browser clients connect to /ws/browser/:workId for live streaming.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import yaml from "js-yaml";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { appendFile } from "node:fs/promises";
import { logBridge, logBridgeDebug } from "./logger.js";
import { loadConfig, dataDir } from "./config.js";
import { MAX_PLAN_DURATION_S } from "./services/quality-gate.js";
import { buildExplicitParamsBlock } from "./server/explicit-params.js";
import { getWork, updateWork, saveStepHistory, loadStepHistory, saveWorkChat, loadWorkChat, type Work, type PipelineStep, type EvalResult } from "./work-store.js";
import { listSharedAssets } from "./shared-assets.js";
import { MemoryClient } from "./memory.js";
import { syncMessage } from "./memory-sync.js";
import { parseEvalResultText } from "./agent/evaluator.js";
import { isQuotaErrorText, reportQuotaExhausted } from "./services/quota-guard.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatBlock {
  type: "user" | "text" | "thinking" | "tool_use" | "tool_result" | "step_divider" | "eval_divider";
  text: string;
  toolName?: string;
  collapsed?: boolean;
  timestamp?: string;
  source?: "creator" | "evaluator";
}

export interface WsSession {
  workId: string;
  cliSessionId?: string;
  evalSessionId?: string;
  evalStep?: string;
  browserSockets: Set<WebSocket>;
  cliProcess?: ChildProcess;
  evalProcess?: ChildProcess;
  idle: boolean;
  messageHistory: ChatBlock[];
  model?: string;
  /** 最近一次 CLI 活动（spawn/stdout 输出）的时间戳；用于区分"回合间静默"与"真死" */
  lastActivityAt?: number;
  // ── LLM 直连（API agent loop）字段，2026-08-17 Phase 1 ──
  loop?: import("./agent/loop.js").AgentLoop;
  loopState?: "idle" | "running";
  loopTurnPromise?: Promise<unknown>;
  agentSessionId?: string;
  /** API 评审 loop 进行中(P2-T1):评审期间创作者 loop 空闲,无此标记 runner 会误判会话死亡
   *  反复 resume/重建会话(2026-08-17 验收实测:eval 窗口内 resumeAttempts 6 次把队列项打 failed) */
  evalLoopRunning?: boolean;
  /** 评审开始时间(2026-08-28 批次1.2):watchdog 据此判定评审挂死(此前 evalStep 只写不读,升级为可读信号) */
  evalStartedAt?: number;
  /** agent 提问等待用户的起始时间(批次2.6 AskUserQuestion 激活):autoMode 超时兜底用 */
  askPendingSince?: number;
  /** autoMode 无人值守续跑计数(P2-T2):步骤 key + 连续空转次数 + 历史长度标记 + 步骤内总次数 */
  autoContinueStep?: string;
  autoContinueCount?: number;
  autoContinueMark?: number;
  autoContinueTotal?: number;
  /** 作品目录实质写入快照(批次3.5 进展判定):mtime 最大值,排除系统自写文件 */
  autoContinueStamp?: number;
  /** 当前 loop 的路由阶段与模型(P2 提速 A):阶段推进时 refreshStageRouting 据此判定重建 */
  routedStage?: string;
  routedModel?: string;
  /** 待触发评审(2026-08-19):agent 在回合中调 advance 时挂上,回合真正结束时由
   *  onLoopTurnEnd 触发——取代 waitForCreatorIdle 固定 120s 白等(每轮评审 2min×N 纯损耗) */
  pendingEval?: { step: string; nextStep?: string };
  /** 上一回合的失败原因(2026-08-26):auto_continue 据此给出针对性续跑指令——
   *  回合超时被杀与主动结束需要完全不同的恢复策略(前者要防"从头重做") */
  lastTurnFailure?: string;
  /** 会话持久化钩子(createSessionApi 注入):每个回合结束都必须调用——
   *  此前只在首回合 finally 持久化,后续回合上下文全在内存,服务重启即丢失
   *  (2026-08-26 实测:work1 装配 3.2 小时上下文险遭回滚) */
  persist?: () => void;
}

interface NdjsonMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  content?: unknown;
  result?: unknown;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── WsBridge ─────────────────────────────────────────────────────────────────

/** 活性宽限期：回合结束后 advance 续命/评审 spawn 有数十秒空窗,
 *  在此期间无 cliProcess 属正常,宽限期内仍视为活跃,防止 queue/watchdog 误判假死重复 spawn */
const ACTIVITY_GRACE_MS = 120_000;

/** 2026-08-31:eco+H3 离线的主动告知按"每进程每作品一次"去重(会话可能多次重建) */
const h3OfflineNotified = new Set<string>();

export class WsBridge {
  private sessions: Map<string, WsSession> = new Map();
  private eventListeners: Map<string, Set<(event: string, data: unknown) => void>> = new Map();
  private chatSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 每作品的 spawn 串行锁:createSession/sendMessage/stale 重试的 kill-then-spawn
   *  必须互斥,否则并发触发会产生脱离跟踪的孤儿 CLI 进程(2026-08-06 根因) */
  private spawnChains: Map<string, Promise<void>> = new Map();
  private browserWss: WebSocketServer;
  /** 全局通知通道(批次4.6):/ws 连接池,广播 eval_blocked/配额冷却/作品失败等全局事件 */
  private globalWss!: WebSocketServer;
  private globalSockets: Set<WebSocket> = new Set();

  /** 回合结束钩子(2026-08-19):api 层注入,用于 pendingEval 的事件驱动评审触发 */
  onLoopTurnEnd?: (workId: string) => void;

  /** 串行化同一作品的 spawn 相关操作 */
  private async withSpawnLock<T>(workId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.spawnChains.get(workId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.spawnChains.set(workId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 作品是否活跃:有存活进程/运行中的 loop,或最近 ACTIVITY_GRACE_MS 内有活动。
   *  queue runner / watchdog 的存活判定必须用这个,而不是只看 cliProcess —
   *  -p 单回合模式下进程每回合退出是常态,纯内存判定会误判假死(2026-08-06 根因)
   *
   *  2026-08-28 批次4.2:"挂死=永活"悖论修复——loopState/evalLoopRunning 不再是无条件
   *  免死金牌:SSE 停滞/评审挂起时它们恒 true 导致 watchdog 永不介入(5e3 僵死 14h)。
   *  现在 running 状态必须配合活性时间窗:超窗即判死(阈值 > bash 工具 600s 上限 +
   *  bash 心跳 12s 续活动,正常长命令不会误判)。 */
  isWorkActive(workId: string): boolean {
    const s = this.sessions.get(workId);
    if (!s) return false;
    if (s.cliProcess || s.evalProcess) return true;
    const now = Date.now();
    const lastActivity = s.lastActivityAt ?? 0;
    // 评审维度:评审硬超时 15min(批次1.2)是主防线,这里 16min 兜底
    if (s.evalLoopRunning) {
      return now - (s.evalStartedAt ?? lastActivity) < 16 * 60_000;
    }
    if (s.loopState === "running") {
      // bash 心跳每 12s 续 lastActivityAt;12min 无任何 loop 事件 = 挂死
      return now - lastActivity < 12 * 60_000;
    }
    return now - lastActivity < ACTIVITY_GRACE_MS;
  }

  constructor(_serverPort: number) {
    this.browserWss = new WebSocketServer({ noServer: true });
    this.browserWss.on("connection", (ws, req) => {
      const workId = this.extractWorkId(req.url ?? "");
      if (workId) this.handleBrowserConnection(workId, ws);
    });
    // 批次4.6:全局通知通道(/ws)——eval_blocked/配额冷却/作品失败等事件推给所有页面,
    // 不再只覆盖"正盯着该作品 Studio 页"的用户
    this.globalWss = new WebSocketServer({ noServer: true });
    this.globalWss.on("connection", (ws) => {
      this.globalSockets.add(ws);
      ws.on("close", () => this.globalSockets.delete(ws));
      ws.on("error", () => this.globalSockets.delete(ws));
    });
    // 批次4.4 session_beat:每 15s 向有活会话的浏览器发心跳(loopState/evalLoopRunning 快照),
    // 前端据此区分"慢(还在跑)"与"停(连接断/真死)",替代 60s 无事件即误判完成的启发式。
    // 纪律:beat 只读状态、绝不更新 lastActivityAt(传输层活性 ≠ loop 进展,灌活会让 watchdog 全盲)。
    const beat = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (s.loopState !== "running" && !s.evalLoopRunning) continue;
        if (!s.browserSockets.size) continue;
        this.broadcastToBrowsers(s.workId, {
          event: "session_beat",
          data: { workId: s.workId, loopState: s.loopState ?? "idle", evalLoopRunning: !!s.evalLoopRunning, evalStep: s.evalStep },
        });
      }
    }, 15_000);
    beat.unref?.();
  }

  // ── Upgrade handler ──────────────────────────────────────────────────────

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url ?? "";
    if (url.match(/^\/ws\/browser\/[^/]+/)) {
      this.browserWss.handleUpgrade(req, socket, head, (ws) => {
        this.browserWss.emit("connection", ws, req);
      });
      return true;
    }
    // 批次4.6:全局通知通道
    if (url === "/ws" || url.startsWith("/ws?")) {
      this.globalWss.handleUpgrade(req, socket, head, (ws) => {
        this.globalWss.emit("connection", ws, req);
      });
      return true;
    }
    return false;
  }

  /** 全局广播(批次4.6 通知中心):发给所有已连接页面 */
  broadcastGlobal(event: string, data: unknown): void {
    const msg = JSON.stringify({ event, data });
    for (const ws of this.globalSockets) {
      try { ws.send(msg); } catch { /* 单连接失败忽略 */ }
    }
  }

  // ── Session management ───────────────────────────────────────────────────

  ensureSession(workId: string): WsSession {
    let session = this.sessions.get(workId);
    if (!session) {
      session = {
        workId,
        idle: true,
        browserSockets: new Set(),
        messageHistory: [],
      };
      this.sessions.set(workId, session);
    }
    return session;
  }

  /**
   * Append a single chat block to the JSONL log on disk.
   * Fire-and-forget — write failure does not block the main flow.
   */
  private appendToChatLog(workId: string, block: ChatBlock): void {
    if (workId.startsWith("trends_")) return;
    const chatFile = join(dataDir, "works", workId, "chat.jsonl");
    appendFile(chatFile, JSON.stringify(block) + "\n", "utf-8").catch(() => {});
  }

  /**
   * Schedule an incremental save of messageHistory to disk.
   * Debounced: fires at most once per 3 seconds per workId regardless
   * of how many times it's called. This prevents message loss on crash
   * (BUG-4) without hammering the disk during active streaming.
   */
  private scheduleIncrementalSave(workId: string): void {
    if (workId.startsWith("trends_")) return;
    const existing = this.chatSaveTimers.get(workId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.chatSaveTimers.delete(workId);
      const session = this.sessions.get(workId);
      if (!session || session.messageHistory.length === 0) return;
      saveWorkChat(workId, { blocks: session.messageHistory }).catch(() => {});
    }, 3000);
    this.chatSaveTimers.set(workId, timer);
  }

  /**
   * Flush all pending incremental saves and clean up timers.
   * MUST be called before process exit to avoid losing the last
   * 3 seconds of chat history on graceful shutdown (SIGTERM/SIGINT).
   */
  destroy(): void {
    for (const [workId, timer] of this.chatSaveTimers) {
      clearTimeout(timer);
      const session = this.sessions.get(workId);
      if (session && session.messageHistory.length > 0) {
        saveWorkChat(workId, { blocks: session.messageHistory }).catch(() => {});
      }
    }
    this.chatSaveTimers.clear();
  }

  /**
   * Build a system prompt with full context for a given work.
   */
  private async buildSystemPrompt(work: Work): Promise<string> {
    const config = await loadConfig();
    const port = config.port;

    // Determine current step (first non-done step)
    const steps = Object.entries(work.pipeline);
    const currentEntry = steps.find(([, s]) => s.status !== "done" && s.status !== "skipped");
    const currentStep = currentEntry ? currentEntry[1].name : steps[0]?.[1]?.name ?? "创作";

    // Workspace path
    const workspacePath = join(dataDir, "works", work.id);

    // Shared assets summary
    let sharedAssetsInfo = "";
    try {
      const assets = await listSharedAssets();
      const categoryLabels: Record<string, string> = {
        characters: "人物", scenes: "场景", music: "音乐",
        templates: "模板", branding: "品牌", general: "通用",
      };
      const parts: string[] = [];
      for (const [category, files] of Object.entries(assets)) {
        const label = categoryLabels[category] ?? category;
        if (files.length > 0) {
          parts.push(`- ${label}(${category}): ${files.join(", ")}`);
        } else {
          parts.push(`- ${label}(${category}): (空)`);
        }
      }
      sharedAssetsInfo = parts.length > 0 ? parts.join("\n") : "暂无公共素材";
    } catch {
      sharedAssetsInfo = "暂无公共素材";
    }

    // Memory context
    let memoryContext = "";
    try {
      const client = await MemoryClient.fromConfig();
      if (client) {
        const topic = work.topicHint ?? work.title;
        const platform = work.platforms[0] ?? "通用";
        memoryContext = await client.buildContext(topic, platform);
      }
    } catch {
      memoryContext = "";
    }

    // 批次10.3(M14):前作失败教训注入(最近事故卡)——失败不再是零教训换皮重跑
    let incidentContext = "";
    try {
      const { recentIncidentDigest } = await import("./services/incidents.js");
      incidentContext = await recentIncidentDigest(3);
    } catch { incidentContext = ""; }

    const platforms = work.platforms.join(", ");

    // 无人值守判定(2026-08-16 用户决策)：autoMode(批量按钮创建) = 全自动,
    // 其余 = 深度介入(保留"等用户确认"规则)。与 api.ts startWorkSession 同一契约。
    const unattended = !!work.autoMode;

    // H3 本地生成可用性(P2 提速 C,2026-08-17):离线必须显性声明——此前 agent 环境检测
    // 查不到 H3 就自作主张"本片不需要 AI 生图"静默降级纯素材库,用户毫不知情。
    // 探测放在这里(loop 创建级,非请求级),3s 超时可控。
    let h3StatusLine = "";
    if (config.h3) {
      const h3Base = config.h3.baseUrl ?? "http://localhost:8188";
      let h3Online = false;
      try {
        const r = await fetch(`${h3Base}/system_stats`, { signal: AbortSignal.timeout(3000) });
        h3Online = r.ok;
      } catch { /* 离线 */ }
      h3StatusLine = h3Online
        ? `- H3 本地生成(ComfyUI ${h3Base}):**在线可用**,人物/场景定制图与视频优先用它`
        : work.assetBudget === "eco"
          // 批次6.3:eco 档与 step-contract"禁用云端、阻塞提醒开机"对齐——
          // 此前此处统一说"用即梦替代",与 eco 门禁(/api/generate/video 代码级 403)直接互斥
          ? `- H3 本地生成(ComfyUI ${h3Base}):**已配置但当前离线**。本作品为 eco 成本档——禁止使用云端视频生成(即梦/Seedance,系统已在 API 层拦截 403),素材规划改用素材库/程序化渲染;确需 AI 视频镜头时阻塞并在交付说明中显著提醒"H3 离线,请开机后重试该镜头"`
          : `- H3 本地生成(ComfyUI ${h3Base}):**已配置但当前离线**(AutoDL 实例未启动或隧道断开)。本作品素材规划不要依赖 H3;用素材库/即梦/程序化渲染替代,并在最终交付说明中明确注明"H3 离线,已降级"。若后续恢复在线可改用。`;
      if (!h3Online) {
        console.warn(`[ws-bridge] H3 离线降级声明已注入:workId=${work.id}`);
        // 2026-08-31 实测用户反馈:eco+H3 离线时 agent 可能整片绕开 AI 视频而用户
        // 毫不知情("按需阻塞"只在真的调 /api/generate/video 时才提醒)。会话启动即
        // 主动告知一次(每进程每作品一次),把"绕开"从静默降级变成显式知情。
        if (work.assetBudget === "eco" && !h3OfflineNotified.has(work.id)) {
          h3OfflineNotified.add(work.id);
          const noticeText = `作品「${work.title.slice(0, 20)}」为 eco 成本档且 AutoDL 实例离线:AI 视频镜头将改用素材库/程序化素材替代;若你希望保留 AI 生成镜头,请开机 AutoDL 实例`;
          const { voiceNotify } = await import("./services/voice-notify.js");
          voiceNotify(noticeText, `h3-offline-notice:${work.id}`);
          this.broadcastGlobal("notify", { level: "warn", kind: "h3_offline", text: noticeText, workId: work.id });
        }
      }
    }

    // 内部 API 契约(P2 提速 B,2026-08-17):agent 猜 code-scene 契约曾空转 35 分钟——
    // 常用端点的精确用法直接写进上下文,禁止靠 grep 源码/读报错摸索。
    const apiContract = `## 内部 API 契约(精确用法,直接照用;禁止 grep 源码找用法)
- 推进流水线: POST http://localhost:${port}/api/works/${work.id}/pipeline/advance  body: {"completedStep":"当前步骤key","nextStep":"下一步骤key"}
- 代码渲染动画(结构图/流程图/逻辑链条等 → 程序化 mp4): POST http://localhost:${port}/api/assets/code-scene
  body: {"workId":"${work.id}","filename":"英文小写带连字符","template":{"name":"NAME","params":{...}}}
  NAME 与 params(十模板,按镜头内容选型):
  · flow-steps(流程步骤): {"title":"≤12字","steps":[{"title":"≤8字","desc":"≤16字,可省"}] ×2-5}
  · structure-growth(中心辐射): {"title":"≤12字","center":"≤6字","branches":[{"text":"≤6字","label":"≤8字"}] ×2-4}
  · logic-chain(逻辑链条): {"title":"≤12字","chain":["每节≤10字"] ×2-4}
  · big-number(大数字冲击): {"title":"≤12字","value":原始数值(54000,也可传已换算的5.4——模板自动归一,禁止自行二次换算),"format":"plain|percent|wan|yi","caption":"≤20字,可省","source":"可省"}
  · compare-split(左右对比): {"title":"≤12字","left":{"label":"≤6字","points":["≤14字"]×2-4},"right":{同左},"verdict":"≤24字,可省"}
  · timeline(时间轴): {"title":"≤12字","events":[{"time":"≤8字","label":"≤16字"}] ×2-5}
  · pyramid(金字塔层级): {"title":"≤12字","levels":["≤12字,自下而上塔底在前"] ×2-5}
  · quote-card(金句卡): {"quote":"≤40字","author":"可省","source":"可省"}
  · checklist(清单打勾): {"title":"≤12字","items":["≤18字"] ×2-6}
  · bar-compare(条形对比): {"title":"≤12字","bars":[{"label":"≤10字","value":数字}] ×2-5,"unit":"可省"}
  可选: "duration":1-30(秒,默认6)、"theme":"finance_dark|warm_gold|ink_green|minimal_light"(与作品模板色系统一)
- assembly 阶段的 advance 有机器门禁,以下缺一即被 400 拦截(提前备齐):
  ① output/ 下文件名含 final 的成片视频 ② output/publish-text.md(发布文案)
  ③ output/quality-report.json——对当前成片跑质量门禁生成,videoPath 指向该片且生成时间不早于成片 ④ output/ 下 .ass 字幕(单可视行 ≤15 字、CPS ≤8)
- plan 阶段的 advance 有机器预检,命中即被 400 拦截(提交前逐项自检):
  ① 分镜表时长合计 ${work.explicitParams?.duration ? `≤${work.explicitParams.duration}s(用户显式时长,豁免通用 ${MAX_PLAN_DURATION_S}s 上限——以显式值为准绳)` : `≤${MAX_PLAN_DURATION_S}s`} ② 旁白单句 ≤20 字 ③ 不得引用 material-candidates.md 剔除区素材
  ④ 标题/封面极限词(最/第一/唯一/首个)必须加「之一」限定
- 模版卡渲染铁律(code-scene customScene):渲染前必须 GET /api/templates/{templateId} 查看
  variables 中的媒体槽位(videoSrc/imageSrc),并传入真实素材路径——槽位留空会渲染出
  灰色占位框,评审按"假窗口"直接打回(2026-08-26 实测三张模版卡全军覆没)
- 环境: Windows + Git Bash;python 用 \`py -3\`(不要用 python3);ffmpeg/ffprobe 可用
- 长耗时命令铁律: 单回合有 30 分钟上限,超时被杀则全回合作废。whisper 转写/批量渲染/批量生成
  这类长任务:① **ASR 转写优先走长任务 API**(不占回合上限):POST http://localhost:${port}/api/long-tasks
  body {"kind":"asr","workId":"本作品ID","inputPath":"媒体绝对路径","outputPath":"输出 ass 绝对路径","model":"small"},
  返回 taskId 后轮询 GET /api/long-tasks/{taskId} 直至 status=done ② 其他长任务单条 Bash 不超过 3 分钟,
  拆段分批 ③ 输出重定向到文件(防孤儿进程持有管道挂死回合) ④ 验证性 ASR 用 small 模型,
  禁止 medium/large(CPU 上 3 分钟音频 medium 要 15-30 分钟,必超回合上限) ⑤ timeout 参数单位是毫秒(600 秒 = 600000)`;

    return `## 系统第一原则：质量优先

- 宁可不交付，不可降质交付。如果所有路径都会导致不可接受的质量损失，停下来告知用户，而不是静默降质出一个"勉强能用"的结果
- 降级必须最小让步：受阻时逐级尝试替代方案，每一级都优先保住对最终内容质量影响最大的环节
- 降质决策必须透明：换模型、换生成方式、跳过步骤等任何涉及质量降级的决策，必须告知用户并获得确认，不可静默执行
- 质量检测前置：批量生成前做样本测试，执行前检测环境能力，把问题拦在源头而非事后补救

---

你是AutoViral创作助手，正在帮用户创建一个${work.type}作品。
目标平台：${platforms}
当前阶段：${currentStep}

${buildExplicitParamsBlock(work)}

## 你的 Skills（技能指南）

你有以下 skill 文件可以阅读，每个 skill 包含该阶段的详细操作指南、平台知识和脚本工具。**在执行每个流水线步骤前，请先阅读对应的 skill 文件。**

| 流水线步骤 | Skill 路径 | 用途 |
|-----------|-----------|------|
| 话题调研 (research) | ~/.claude/skills/trend-research/SKILL.md | 趋势研究方法、数据获取脚本、评估框架 |
| 内容规划 (plan) | ~/.claude/skills/content-planning/SKILL.md | 分镜脚本、构图原则、节奏模板 |
| 素材生成 (assets) | ~/.claude/skills/asset-generation/SKILL.md | AI生图/生视频提示词工程、风格一致性 |
| 内容合成 (assembly) | ~/.claude/skills/content-assembly/SKILL.md | ffmpeg剪辑、字幕、配乐、发布文案 |

每个 skill 下还有以下子目录，请按需阅读：
- **references/** — 平台专属知识。根据目标平台阅读 references/douyin.md 或 references/xiaohongshu.md
- **genres/** — 内容类型专项指南。**在开始每个流水线步骤前，根据作品的内容类型阅读对应的 genres/<type>.md**。现有内容类型：
    - \`comedy.md\` — 搞笑/抽象类（情绪驱动模板：观点输出型、对话截图型、反差跃迁型、清单盘点型）
    - \`narrative.md\` — 叙事类（科幻短片、微电影、剧情类 — 用故事结构而非情绪模板）
    - \`knowledge.md\` — 知识类（教程、测评、科普 — 用教学逻辑而非情绪模板）
    - \`showcase.md\` — 展示类（Vlog、旅行、美食制作 — 用场景流程而非情绪模板）
    - \`rhythm.md\` — 节奏类（卡点视频、舞蹈、音乐可视化 — 用节拍映射而非情绪模板）
    **注意**：如果用户选的是"other"自定义类别（如"科幻"），应优先根据主题判断内容类型（科幻→narrative），然后阅读对应 genres/ 文件，而不是套用默认的焦虑类情绪模板
  - **modules/** — 扩展能力模块。以下按阶段**必须阅读**（非可选；2026-08-14 起强制，此前"按需阅读"导致调色/声音等模块从未被加载）：
    - **research（话题调研）阶段必读**：\`trend-research/modules/topic-scorecard.md\`（选题评分卡：五要素打分/三无否决/对标拆解法）
    - **plan（内容规划）阶段必读**：\`content-planning/modules/packaging-first.md\`（包装先行：标题四式/封面概念/承诺一致性校验，先于分镜执行）、\`content-planning/modules/hook-engineering.md\`（钩子工程：9类钩子模板/开场三步/多Hook版本）、\`content-planning/modules/script-structure.md\`（口播脚本五段式时间轴/结构选择器）、\`content-planning/modules/storyboard-grammar.md\`（分镜语法：景别功能/运镜理由/pattern interrupt）、\`content-planning/modules/visual-aesthetics.md\`（视觉美学）；财经/政策类内容追加 \`content-planning/modules/finance-compliance.md\`（合规红线）
    - **assets（素材准备）阶段必读**：\`asset-generation/modules/prompt-compiler.md\`（生成prompt编译：五槽公式/单运动约束/负面词库）、\`asset-generation/modules/quality-gate.md\`（生成质量自检）、\`asset-generation/modules/fallback-strategy.md\`（受阻降级决策树）
    - **assembly（内容合成）阶段必读**：\`content-assembly/modules/audio-spec.md\`（声音设计：LUFS响度/三层混音/SFX音效层）、\`content-assembly/modules/color-grading.md\`（调色）、\`content-assembly/modules/subtitle-aesthetics.md\`（字幕美学）；卡点类内容追加 \`modules/beat-sync.md\`
    - \`modules/emotional-hooks.md\` — 情绪驱动内容公式（comedy 类适用）
    - 评审依据：各阶段评审标准见 \`content-evaluator/criteria/<step>.md\`，评审会逐条核对这些模块的执行情况
## 你的能力
- 调研：使用WebSearch搜索 + 数据获取脚本（详见 trend-research skill）
- 生图：脚本工具 py -3 ~/.claude/skills/asset-generation/scripts/openrouter_generate.py 或 jimeng_generate.py（详见 asset-generation skill）
- 生视频：调用 curl http://localhost:${port}/api/generate/video 或使用即梦脚本
- 程序化动画: curl http://localhost:${port}/api/assets/code-scene(结构图/流程图/逻辑链条镜头,参数化模板渲染 mp4 段,详见 asset-generation skill 路由速查表)
- 合成：使用ffmpeg命令剪辑视频（拼接片段+字幕+配乐+转场）
- 字幕管线（强制）：
  1. **生成字幕文件**：使用 py -3 ~/.claude/skills/content-assembly/scripts/caption_generate.py 生成 ASS 字幕（支持 douyin-highlight/xhs-soft/funny/minimal 等预设风格 + 逐词高亮 karaoke）。如果你有手动时间戳 JSON，也可以用 --timestamps 模式；否则用 --input 自动语音识别模式
  2. **烧录字幕到视频（默认路径，必须）**：使用 ffmpeg 原生 ass 滤镜烧录，单次编码、音频直拷：
     ffmpeg -i composited.mp4 -vf "ass=subs.ass:fontsdir='C\\:/Users/顾庆冲/.autoviral/fonts'" -c:v libx264 -preset veryfast -crf 20 -c:a copy -y output/final.mp4
     Windows 下盘符冒号需转义（C\\:/）；路径含中文时先 cd 到作品目录用相对路径。**禁止用 ffmpeg drawtext 或手写 Pillow 方案**
  3. **备用路径**：仅当输入是 SRT 且不需要 karaoke、或 ffmpeg 无 libass 时，才用 py -3 ~/.claude/skills/content-assembly/scripts/subtitle_burn.py（注意：它会剥掉 {\\kf} karaoke 标签并忽略 ASS MarginV，ASS+karaoke 场景禁用）
  4. **字体**：必须使用 ~/.autoviral/fonts/ 下的高质量字体（NotoSansCJKsc-Bold.otf，家族名 Noto Sans CJK SC），禁止使用系统字体；libass 日志出现 fontselect 回退系统字体时必须停下来修正 Fontname
  5. **布局安全区（强制）**：字幕带（MarginV=430，y≈1390–1550）与数字人/字卡 overlay 坐标必须由同一份布局常量计算且断言不相交；数字人分窗固定预设 scale=420:-2,pad=428:754 + overlay=616:200；合成后在 10%/50%/90% 抽帧复核遮挡
- BGM 配乐（强制）：
  1. BGM 只能来自以下渠道：公共素材库音乐（/api/shared-assets 中 music 类）、curl http://localhost:${port}/api/generate/music（MiniMax music-2.6，传 duration 自动补齐时长，可按情绪/BPM/乐器写 prompt）、yt-dlp 下载免版权音乐。**禁止用 ffmpeg 合成正弦波/白噪声/棕噪声等充当 BGM**——这属于静默降质，违反质量第一原则
  2. BGM 时长必须 ≥ 视频时长；接缝处必须交叉淡化，禁止生硬重复
  3. 混音用响度锚定（禁止拍脑袋 volume 比例）：旁白轨 loudnorm=I=-15:TP=-1.5:LRA=11，BGM 轨 loudnorm=I=-34:TP=-3:LRA=11（低于旁白约 19dB）再混入；BGM 能量强时再降 3dB；旁白清晰度永远优先
  4. 以上渠道全部不可用时，停下来明确报告"无可用 BGM 渠道"，不得在方案中承诺不存在的资源，也不得即兴合成
- 资源可达性检查（必做）：规划阶段引用任何外部资源通道（Pixabay Music、Pexels、Unsplash、Lyria、即梦等）前，先验证该通道已配置可用（config 中有 apiKey / 接口实测可通）。**未配置的通道不得写进方案**，直接改用已配置的替代通道
- 公共素材：通过 curl http://localhost:${port}/api/shared-assets 查看可用素材
- 素材库检索（Pexels/Pixabay，key 由服务端持有——直接调用即可，禁止自行读取 config 找 key、禁止直连 api.pexels.com）：
  搜索：curl "http://localhost:${port}/api/stock-assets/search?q=英文关键词&type=video|image&perPage=10"（英文关键词命中最好，竖版 height>width 优先）
  下载：curl -X POST http://localhost:${port}/api/stock-assets/download -H "Content-Type: application/json" -d '{"url":"ITEM_URL","provider":"pexels","mediaType":"video","category":"scenes","name":"shot-NN.mp4","description":"...","author":"...","license":"...","duration":12}'
- **Windows 中文编码铁律（2026-08-19，违反必出乱码）**：任何含中文的 POST body 禁止 curl -d 内联 JSON——Git Bash 会损坏中文编码（code-scene 中文乱码成片事故真凶）。必须先用 Write 工具把 JSON 写成 UTF-8 文件，再 curl --data-binary @文件名.json。纯 ASCII 的 body 才可内联。
- 流水线管理：调用 curl -X POST http://localhost:${port}/api/works/${work.id}/pipeline/advance 更新流水线状态

## 前置检测（必做）

**素材生成阶段第一步**：在任何生图/生视频操作前，必须先运行环境检测：
\`\`\`
py -3 ~/.claude/skills/asset-generation/scripts/check_environment.py --format summary
\`\`\`
根据检测结果选择合适的工具和降级策略。**禁止跳过此步骤**——否则会导致用不存在的工具反复尝试失败、浪费积分和时间。

## 受阻降级策略

当你在执行过程中遇到阻碍时，阅读 ~/.claude/skills/asset-generation/modules/fallback-strategy.md 获取完整的降级策略指导。核心原则：
- **质量优先**：宁可告知用户不可行，不可静默降质
- **最小让步**：逐级尝试，优先保住对最终内容质量影响最大的环节
- **透明决策**：涉及质量降级的决策必须告知用户
- **前置检测**：批量执行前先做样本测试和环境检测
- **首帧驱动**：视频生成优先使用 image2video（保留首帧控制力），text2video 仅作为降级方案

## 可用数据源

在创作过程中，你可以按需访问以下数据（请求失败则跳过，不阻断流程）：
- **创作者数据**：\`curl http://localhost:${port}/api/analytics/creator\` — 获取用户的粉丝数、互动率、作品表现，据此推荐适合用户量级的内容策略
- **记忆搜索**：\`curl "http://localhost:${port}/api/memory/search?q=关键词&method=hybrid&topK=5"\` — 搜索历史创作经验，避免重复选题
- **用户画像**：\`curl http://localhost:${port}/api/memory/profile\` — 获取创作风格档案

## 流水线（Pipeline）
作品ID：${work.id}
流水线步骤：${steps.map(([key, s]) => `${key}(${s.name}): ${s.status}`).join(" → ")}

**重要：你必须主动管理流水线状态。** 每次回答用户之前，根据对话上下文判断当前阶段是否已经完成、是否需要推进到下一步。
- 当你判断当前阶段的工作已经完成（例如调研报告已输出、规划方案已确认），**立即调用** pipeline/advance API 更新状态：
  curl -X POST http://localhost:${port}/api/works/${work.id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"当前步骤key","nextStep":"下一步骤key"}'
- 当用户明确要求进入下一阶段时，同样调用此API。
- 不要等用户来点按钮，你自己判断并更新。
- 不要在工作未完成时提前推进。

## 当前项目workspace
${workspacePath}

## 公共素材库
${sharedAssetsInfo}

## 记忆上下文（如有）
${memoryContext}
${incidentContext ? `\n## 前作失败教训(近期事故卡——这些坑别的作品刚踩过,不要重蹈)\n${incidentContext}\n` : ""}

${apiContract}

## 素材生成环境
${h3StatusLine || "- H3 本地生成: 未配置"}

## 规则
- 调研阶段：如果用户指定了方向，围绕该方向深入调研；否则广泛调研热门趋势
${unattended
  ? `- 本作品为无人值守自动流水线：每步计划与素材生成直接执行，全程不得等待用户确认、反馈或拍板；所有创意选择自行按 skill 推荐方案决定`
  : `- 每生成一个素材前，先描述计划，等用户确认
- 素材生成后展示预览链接，等用户反馈`}
- 短视频制作：先生成首帧图片→用首帧图生成视频片段→ffmpeg剪辑合成
- 可随时引用公共素材库中的人物、配乐等素材
- 只支持抖音和小红书平台
${unattended
  ? `- 阶段完成立即自行调用 pipeline/advance 推进，无需任何人确认`
  : `- 不要在未经用户确认的情况下自动跳转到下一阶段`}`;
  }

  /**
   * Start a new agent session. Loads work context, builds system prompt,
   * runs on the API agent loop(P4-T2 起 CLI spawn 路径删除).
   */
  async createSession(workId: string, initialPrompt: string, model?: string): Promise<WsSession> {
    logBridge("session_create", workId, { model, promptLen: initialPrompt.length });
    return this.withSpawnLock(workId, () => this.createSessionLocked(workId, initialPrompt, model));
  }

  private async createSessionLocked(workId: string, initialPrompt: string, model?: string): Promise<WsSession> {
    const existing = this.sessions.get(workId);
    if (existing?.cliProcess) {
      try { existing.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
    }

    // LLM 直连：llm.providers 已配置 → API agent loop(P2-T2 起含 autoMode)
    if (await this.useApiDriver(workId)) {
      logBridge("session_create_api", workId, { model });
      return this.createSessionApi(workId, initialPrompt, model);
    }

    // P4-T2(2026-08-19):CLI 路径删除——未配置 provider 时显式报错引导配置,
    // 不再静默回落 claude CLI(烧订阅配额 + Windows 下问题是主要事故源)
    throw new Error("未配置大模型直连——请到设置页「大模型直连」配置至少一家 provider 的 API Key 后重试");
  }

  // ── LLM 直连（API agent loop）路径，2026-08-17 Phase 1 ─────────────────────

  /**
   * 是否走 API loop：llm.providers 已配置即走。
   * P2-T2(2026-08-17)起 autoMode 解禁——结构压缩(maybeCompact)+三道闸就位,
   * 无人值守规则由 buildSystemPrompt 的 isUnattended 段注入(与 CLI 同一来源)。
   */
  private async useApiDriver(workId: string): Promise<boolean> {
    try {
      const config = await loadConfig();
      if (!config.llm?.providers || Object.keys(config.llm.providers).length === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  /** API loop 版 createSession：agent-session.json 还原或全新开局 */
  private async createSessionApi(workId: string, initialPrompt: string, model?: string): Promise<WsSession> {
    const { loadAgentSession, saveAgentSession } = await import("./agent/session-store.js");
    const { randomUUID } = await import("node:crypto");

    const existing = this.sessions.get(workId);
    const session: WsSession = {
      workId,
      idle: false,
      browserSockets: existing?.browserSockets ?? new Set(),
      messageHistory: existing?.messageHistory ?? [],
      model,
    };
    this.sessions.set(workId, session);

    // 重启后内存无历史时从 chat.jsonl 回放（与 CLI 路径同一逻辑）
    if (session.messageHistory.length === 0) {
      try {
        const jsonlPath = join(dataDir, "works", session.workId, "chat.jsonl");
        const raw = await readFile(jsonlPath, "utf-8");
        const blocks: ChatBlock[] = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try { blocks.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
        if (blocks.length > 0) session.messageHistory = blocks;
      } catch { /* 无历史 */ }
    }

    const config = await loadConfig();
    const work = await getWork(workId);
    if (!work) throw new Error("Work not found");

    // 还原或全新开局
    const restored = await loadAgentSession(workId);
    session.agentSessionId = restored?.sessionId ?? `api-${randomUUID()}`;

    // 阶段路由解析+loop 构建已抽为 buildApiLoop——阶段推进时 sendMessage 前重解析(P2 提速 A)
    const routed = await this.buildApiLoop(session, work, config, restored?.messages);
    if (restored?.pendingAskToolUseId) routed.pendingAskToolUseId = restored.pendingAskToolUseId;
    session.loop = routed;

    // 状态持久化（回合结束即写;loop 可能已被阶段重路由换新——读 session.loop 现值）
    const persist = (): void => {
      saveAgentSession(workId, {
        version: 1,
        sessionId: session.agentSessionId!,
        model: session.routedModel ?? "unknown",
        messages: session.loop?.messages ?? [],
        pendingAskToolUseId: session.loop?.pendingAskToolUseId ?? null,
        createdAt: restored?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    };
    session.persist = persist;

    session.cliSessionId = session.agentSessionId; // 前端透传展示用
    this.broadcastToBrowsers(workId, {
      event: "session_ready",
      data: { workId, cliSessionId: session.agentSessionId },
    });

    // 首回合消息：新会话带完整任务说明(systemPrompt 已独立携带全量上下文,无需拼进 user 消息);
    // 还原会话(messages 非空)不得重发完整 initialPrompt——初始任务说明重复注入会让模型
    // 误以为任务重启(2026-08-26 实测:work2 重启恢复后模型重复执行已完成动作,
    // 随后退化为 Bash(":") 空操作循环直至 LoopGuard 杀回合)。
    // 恢复指令必须显式点名当前阶段:agent 的消息历史停留在被杀死回合之前(持久化只在
    // 回合结束发生),不点名阶段它会沿旧上下文重做已完成阶段(同日实测:对已 done 的
    // material-search 再次 advance 白跑一轮评审)
    const restoredHasHistory = (restored?.messages?.length ?? 0) > 0;
    let firstMessage = initialPrompt;
    if (restoredHasHistory) {
      const currentEntry = Object.entries(work.pipeline).find(([, s]) => s.status !== "done" && s.status !== "skipped");
      const stageDesc = Object.entries(work.pipeline).map(([k, s]) => `${s.name ?? k}:${s.status}`).join(" → ");
      firstMessage = currentEntry
        ? `会话已从断点恢复。当前流水线状态:${stageDesc}。请直接继续「${currentEntry[1].name ?? currentEntry[0]}」阶段的工作;该阶段之前的所有阶段均已完成,禁止重做或重复推进它们。`
        : "会话已从断点恢复。流水线全部阶段已完成,无需再执行任何创作动作。";
    }
    session.loopState = "running";
    session.loopTurnPromise = routed
      .runTurn(firstMessage)
      .then((r) => this.onTurnSettled(session, r))
      .catch((err) => {
        session.lastTurnFailure = err instanceof Error ? err.message : String(err);
        console.error(`[agent-loop] turn failed for ${workId}:`, err);
      })
      .finally(() => {
        session.loopState = "idle";
        session.idle = true;
        persist();
        this.onLoopTurnEnd?.(workId);
        this.scheduleAutoContinue(session);
      });

    return session;
  }

  /**
   * 按当前流水线阶段解析路由并构建 AgentLoop(P2 提速改造 A,2026-08-17)。
   * 从 createSessionApi 抽出,供两处复用:建会话、sendMessage 前的阶段重解析——
   * 一部作品的各阶段从此真正各走各的模型(research=kimi 搜索、plan/assembly=deepseek-pro…),
   * 不再全程锁死在创建时的模型上。
   */
  private async buildApiLoop(
    session: WsSession,
    work: Work,
    config: Awaited<ReturnType<typeof loadConfig>>,
    messages?: import("./llm/types.js").AgentMessage[],
  ): Promise<import("./agent/loop.js").AgentLoop> {
    const { AgentLoop } = await import("./agent/loop.js");
    const { buildCreatorTools } = await import("./agent/tools/index.js");
    const { PROVIDER_PRESETS } = await import("./llm/provider-keys.js");
    const { resolveVision } = await import("./agent/evaluator.js");
    const { resolveModelFor } = await import("./llm/registry.js");
    const { createLoopEventSink } = await import("./agent/ws-compat.js");
    const workId = session.workId;

    // 阶段模型路由：当前流水线步骤 → StageKey
    const currentStep = Object.entries(work.pipeline).find(([, s]) => s.status === "active" || s.status === "pending")?.[0] ?? "plan";
    const stageKey = (currentStep === "material-search" ? "research" : currentStep) as "research" | "plan" | "assets" | "assembly";
    const { provider, model: usedModel } = resolveModelFor(config, stageKey in { research: 1, plan: 1, assets: 1, assembly: 1 } ? stageKey : "plan");
    session.routedStage = currentStep;
    session.routedModel = usedModel;

    // 平台内置联网搜索(如 Kimi $web_search):provider 预设声明了能力才挂,loop 按两段协议回填
    const searchToolName = PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
    const builtinTools = searchToolName
      ? [{
          name: searchToolName,
          builtin: true,
          description: "联网搜索(平台服务端执行)。涉及时效性话题、热点、资料查证时调用;调用后平台自动执行并注入结果,无需任何参数处理。",
          input_schema: { type: "object", properties: {} },
        }]
      : [];

    let systemPrompt = await this.buildSystemPrompt(work);
    if (builtinTools.length) {
      // 工具名映射声明:skills/提示词按 CLI 命名写死 WebSearch,API loop 下平台内置工具叫 $web_search;
      // 不显式声明时模型会退回 curl 抓站(2026-08-17 验收实测:kimi 连续 100+ 次 bash curl 打转)
      systemPrompt += `\n\n**联网搜索工具**:本环境的联网搜索工具名为 \`$web_search\`(即本文档与 skills 中提到的 WebSearch)。调用后平台自动执行搜索并注入结果,无需任何参数处理。**禁止用 curl/wget 抓取网页**代替搜索。`;
    }

    const sink = createLoopEventSink(session, this);
    // 创作者同样需要视觉路由(读素材图/参考图):无视觉模型时图片降格文本,不再 400(2026-08-17 live)
    const creatorVision = resolveVision(config, provider.name);
    return new AgentLoop(
      {
        provider,
        model: usedModel,
        systemPrompt,
        tools: buildCreatorTools({ bashBlocklist: config.llm?.guard?.bashBlocklist }),
        builtinTools,
        visionProvider: creatorVision?.provider,
        visionModel: creatorVision?.model,
        workDir: join(dataDir, "works", workId),
        onLoopEvent: (ev) => {
          session.lastActivityAt = Date.now();
          sink(ev);
        },
        guard: {
          maxStepsPerTurn: config.llm?.guard?.maxStepsPerTurn,
          maxTurnMinutes: config.llm?.guard?.maxTurnMinutes,
        },
        usageContext: { workId, stage: stageKey },
      },
      messages,
    );
  }

  /**
   * 阶段重解析(P2 提速 A):流水线阶段已推进 → 用新阶段的路由重建 loop,
   * 上下文经内存消息直接移交(无需落盘往返)。步骤没变则不动。
   */
  private async refreshStageRouting(session: WsSession): Promise<void> {
    if (!session.loop) return;
    const work = await getWork(session.workId);
    if (!work) return;
    const currentStep = Object.entries(work.pipeline).find(([, s]) => s.status === "active" || s.status === "pending")?.[0];
    if (!currentStep || currentStep === session.routedStage) return;
    logBridge("stage_reroute", session.workId, { from: session.routedStage, to: currentStep, model: session.routedModel });
    const config = await loadConfig();
    const pendingAsk = session.loop.pendingAskToolUseId;
    const loop = await this.buildApiLoop(session, work, config, session.loop.messages);
    if (pendingAsk) loop.pendingAskToolUseId = pendingAsk;
    session.loop = loop;
  }

  /**
   * autoMode 无人值守驱动(P2-T2,2026-08-17 验收缺口):回合结束但当前步骤仍 active
   * (agent 提前收工未 advance)→ 2s 后自动发继续指令。无人在线时回合干停=流水线停摆,
   * 此前靠 runner resumeAttempts 恢复,计数打爆(>5)作品被判 failed。
   * 同一步骤最多续 15 次防空转;评审中(evalLoopRunning/evaluating)不干预。
   */
  /** 作品目录实质写入快照(批次3.5):浅扫 steps/assets/output/research/plan 子目录的最大 mtime,
   *  排除系统自写文件(chat.jsonl/agent-session.json/eval-*.json/eval-timeout-*.json) */
  private async workProgressStamp(workId: string): Promise<number> {
    const NOISE = /^(chat\.jsonl|agent-session\.json|eval(-timeout)?-.*\.json)$/;
    const root = join(dataDir, "works", workId);
    let max = 0;
    for (const sub of ["", "steps", "assets", "output", "research", "plan"]) {
      try {
        for (const name of await readdir(join(root, sub))) {
          if (NOISE.test(name)) continue;
          try {
            const st = await stat(join(root, sub, name));
            if (st.isFile() && st.mtimeMs > max) max = st.mtimeMs;
          } catch { /* 单文件失败跳过 */ }
        }
      } catch { /* 子目录不存在跳过 */ }
    }
    return max;
  }

  /** 回合正常结束钩子(批次2.6):awaiting_user = agent 提问等用户,记录计时并安排无人值守兜底 */
  private onTurnSettled(session: WsSession, r?: { stopReason?: string }): void {
    if (r?.stopReason === "awaiting_user" && session.loop?.pendingAskToolUseId) {
      session.askPendingSince = Date.now();
      this.scheduleAskTimeout(session);
    }
  }

  /** autoMode 提问超时兜底(批次2.6):无人值守时问题永远没人答,
   *  10 分钟未答则按"最小降质+显式声明"自动继续(优于永久阻塞——三难困境的合法出口) */
  private scheduleAskTimeout(session: WsSession): void {
    const ASK_TIMEOUT_MS = 10 * 60_000;
    const askId = session.loop?.pendingAskToolUseId;
    setTimeout(() => {
      void (async () => {
        try {
          if (!session.loop?.pendingAskToolUseId || session.loop.pendingAskToolUseId !== askId) return; // 已作答
          if (session.loopState === "running") return;
          session.askPendingSince = undefined;
          logBridge("ask_timeout_fallback", session.workId, {});
          await this.sendMessage(
            session.workId,
            "用户未在 10 分钟时限内作答。请按最小降质方案自行拍板并立即继续,且在产出中显式声明该决策、理由及降质幅度。",
          );
        } catch { /* 兜底失败不阻断主流程 */ }
      })();
    }, ASK_TIMEOUT_MS);
  }

  private scheduleAutoContinue(session: WsSession): void {
    if (session.workId.startsWith("trends_")) return;
    setTimeout(() => {
      void (async () => {
        try {
          if (session.loopState === "running" || session.evalLoopRunning) return;
          // 批次2.6:agent 调用 AskUserQuestion 等待用户时禁止续跑——
          // 此前 finally 无条件 scheduleAutoContinue,2 秒后"继续执行,不要等确认"
          // 会当场击穿任何提问机制(论证新发现 #4)
          if (session.loop?.pendingAskToolUseId) return;
          const work = await getWork(session.workId);
          if (!work?.autoMode) return;
          const active = Object.entries(work.pipeline).find(([, s]) => s.status === "active");
          if (!active) return; // 评审中/已完结/已卡死:各有归属,不续跑
          const [stepKey] = active;
          if (session.autoContinueStep !== stepKey) {
            session.autoContinueStep = stepKey;
            session.autoContinueCount = 0;
            session.autoContinueTotal = 0;
            session.autoContinueMark = session.messageHistory.length;
            session.autoContinueStamp = await this.workProgressStamp(session.workId);
          }
          // 批次3.5 进展判定修复:①被杀回合(LoopGuard/超时/停滞)的历史增长是幻觉,
          // 不算进展(旧逻辑让死循环每 4 次自我赦免一次);②真进展=作品目录实质写入
          // (素材/成片/脚本落盘),排除 chat.jsonl 等系统自写文件
          const wasKilled = !!session.lastTurnFailure;
          const stamp = await this.workProgressStamp(session.workId);
          const dirProgressed = stamp > (session.autoContinueStamp ?? 0);
          session.autoContinueStamp = stamp;
          const historyGrew = session.messageHistory.length - (session.autoContinueMark ?? 0) >= 3;
          const progressed = dirProgressed || (historyGrew && !wasKilled);
          session.autoContinueMark = session.messageHistory.length;
          session.autoContinueCount = progressed ? 0 : (session.autoContinueCount ?? 0) + 1;
          session.autoContinueTotal = (session.autoContinueTotal ?? 0) + 1;
          if ((session.autoContinueCount ?? 0) >= 15 || (session.autoContinueTotal ?? 0) >= 60) {
            console.warn(`[ws-bridge] auto_continue 放弃:${session.workId}/${stepKey} 空转${session.autoContinueCount} 总续跑${session.autoContinueTotal}`);
            return;
          }
          logBridge("auto_continue", session.workId, { step: stepKey, stall: session.autoContinueCount });
          // 回合超时被杀 vs 主动收工:恢复策略完全不同(2026-08-26 实证——超时被杀后
          // agent 从头重做,whisper 验证跑三轮烧掉 40 分钟)。被杀的要点名断点续作,
          // 并给长耗时命令规范,防止下一个回合再被 30min 上限杀掉
          const timeoutKilled = (session.lastTurnFailure ?? "").includes("回合超时");
          session.lastTurnFailure = undefined;
          await this.sendMessage(
            session.workId,
            timeoutKilled
              ? "上一回合因单回合时长上限被系统终止。请从中断点继续，不要从头重做：先检查半成品文件（已生成的音频/视频/脚本）是否已落盘，已完成的直接复用。长耗时命令（whisper 转写/渲染/批量生成）必须拆小步执行：单个 Bash 命令控制在 3 分钟内，长任务输出重定向到文件并分片处理，禁止一条命令跑 10 分钟以上。"
              : "继续执行当前阶段任务,不要中途停下等确认——一口气把本阶段做完。若本阶段产出已全部完成,请立即调用 pipeline/advance 推进流水线。",
          );
        } catch { /* 续跑失败不阻断主流程 */ }
      })();
    }, 2000);
  }

  /**
   * Create an ephemeral trend research session.
   * P4-T1(2026-08-19):CLI spawn 平移为 API loop——research 档路由(kimi 联网),
   * search_query/search_result/analyzing/research_done 事件序列由 loop 事件复刻。
   */
  async createTrendSession(sessionKey: string, prompt: string): Promise<WsSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.cliProcess) {
      try { existing.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
    }
    if (existing?.loop && existing.loopState === "running") {
      existing.loop.abortTurn();
    }

    const session: WsSession = {
      workId: sessionKey,
      idle: false,
      browserSockets: existing?.browserSockets ?? new Set(),
      messageHistory: [],
      model: "api-loop",
    };
    this.sessions.set(sessionKey, session);

    const platform = sessionKey.split("_")[1] ?? "unknown";
    const { AgentLoop } = await import("./agent/loop.js");
    const { buildCreatorTools } = await import("./agent/tools/index.js");
    const { PROVIDER_PRESETS } = await import("./llm/provider-keys.js");
    const { resolveModelFor } = await import("./llm/registry.js");
    const config = await loadConfig();
    const { provider, model } = resolveModelFor(config, "research");

    const searchToolName = PROVIDER_PRESETS[provider.name]?.builtinSearchTool;
    const builtinTools = searchToolName
      ? [{
          name: searchToolName,
          builtin: true,
          description: "联网搜索(平台服务端执行)。涉及时效性话题、热点、资料查证时调用;调用后平台自动执行并注入结果,无需任何参数处理。",
          input_schema: { type: "object", properties: {} },
        }]
      : [];

    // CLI 事件序列复刻:搜索调用→search_query;搜索结果→search_result;结果后文本→analyzing
    let lastEventWasToolResult = false;
    const onLoopEvent = (ev: import("./agent/loop.js").LoopEvent): void => {
      session.lastActivityAt = Date.now();
      if (ev.type === "tool_use" && (ev.toolName === "WebSearch" || ev.toolName === searchToolName)) {
        const q = (ev.toolInput as Record<string, unknown> | undefined)?.query;
        this.broadcastToBrowsers(sessionKey, { event: "search_query", data: { query: String(q ?? "") } });
        lastEventWasToolResult = false;
      } else if (ev.type === "tool_result") {
        const summary = (ev.toolResult ?? "").toString().slice(0, 80) || "搜索完成";
        this.broadcastToBrowsers(sessionKey, { event: "search_result", data: { summary } });
        lastEventWasToolResult = true;
      } else if (ev.type === "text_delta" && lastEventWasToolResult) {
        this.broadcastToBrowsers(sessionKey, { event: "analyzing", data: {} });
        lastEventWasToolResult = false;
      }
    };

    const loop = new AgentLoop({
      provider,
      model,
      systemPrompt: [
        "你是专业的社交媒体趋势研究员。使用可用工具完成调研并把结果写入指定文件。",
        searchToolName
          ? `联网搜索工具名为 \`${searchToolName}\`(即 WebSearch),平台自动执行并注入结果;禁止用 curl/wget 抓网页代替搜索。`
          : "",
      ].filter(Boolean).join("\n"),
      tools: buildCreatorTools({ bashBlocklist: config.llm?.guard?.bashBlocklist }),
      builtinTools,
      workDir: join(dataDir, "trends", platform),
      onLoopEvent,
      usageContext: { workId: sessionKey, stage: "research:trend-session" },
    });
    session.loop = loop;
    session.loopState = "running";
    session.loopTurnPromise = loop
      .runTurn(prompt)
      .catch((err) => {
        console.error(`[trend-session] ${sessionKey} loop 失败:`, err instanceof Error ? err.message : err);
        this.broadcastToBrowsers(sessionKey, {
          event: "research_error",
          data: { message: err instanceof Error ? err.message : "调研失败" },
        });
      })
      .finally(() => {
        session.loopState = "idle";
        session.idle = true;
        this.finalizeTrendData(sessionKey).catch(() => {}).finally(() => {
          this.broadcastToBrowsers(sessionKey, { event: "research_done", data: { platform } });
          this.cleanupTrendSession(sessionKey);
        });
      });

    this.broadcastToBrowsers(sessionKey, {
      event: "research_started",
      data: { platform },
    });

    return session;
  }

  /**
   * Send a follow-up message using --resume + new -p.
   * Kills current CLI (if busy) and spawns a new one that resumes the session.
   */
  async sendMessage(workId: string, text: string): Promise<boolean> {
    const session = this.sessions.get(workId);
    if (!session) return false;

    const userBlock: ChatBlock = {
      type: "user",
      text,
      timestamp: new Date().toISOString(),
    };
    session.messageHistory.push(userBlock);
    this.appendToChatLog(workId, userBlock);
    this.scheduleIncrementalSave(workId);

    // Real-time memory sync — user message
    if (!workId.startsWith("trends_")) {
      getWork(workId).then(w => {
        if (!w) return;
        const activeStep = Object.entries(w.pipeline).find(([, s]) => s.status === "active");
        if (activeStep) {
          syncMessage(workId, w.title, activeStep[0], "user", text).catch(() => {});
        }
      }).catch(() => {});
    }

    return this.withSpawnLock(workId, () => this.sendMessageLocked(session, text));
  }

  private async sendMessageLocked(session: WsSession, text: string): Promise<boolean> {
    const workId = session.workId;
    session.askPendingSince = undefined; // 有消息(用户作答/系统兜底)到达,提问等待结束

    // API loop 路径：免 resume，直接续跑;阶段已推进则先重解析路由重建 loop(P2 提速 A)
    if (session.loop) {
      if (session.loopState === "running") {
        session.loop.abortTurn();
        try { await session.loopTurnPromise; } catch { /* 忽略中断错误 */ }
      }
      await this.refreshStageRouting(session);
      session.loopState = "running";
      session.idle = false;
      session.loopTurnPromise = session.loop
        .runTurn(text)
        .then((r) => this.onTurnSettled(session, r))
        .catch((err) => {
          session.lastTurnFailure = err instanceof Error ? err.message : String(err);
          console.error(`[agent-loop] follow-up turn failed for ${workId}:`, err);
        })
        .finally(() => {
          session.loopState = "idle";
          session.idle = true;
          session.persist?.();
          this.onLoopTurnEnd?.(workId);
          this.scheduleAutoContinue(session);
        });
      this.broadcastToBrowsers(workId, {
        event: "session_state",
        data: { idle: false },
      });
      return true;
    }

    // P4-T2(2026-08-19):CLI resume 路径删除。无 loop 的会话属异常态
    // (正常会话经 createSessionApi 建立 loop),显式报错而非静默 CLI 回落
    console.error(`[ws-bridge] sendMessage:${workId} 会话无 API loop(CLI 已于 P4-T2 下线),消息未发送`);
    return false;
  }

  killSession(workId: string): boolean {
    const session = this.sessions.get(workId);
    if (!session) return false;

    // API loop 路径：中断回合
    if (session.loop) {
      session.loop.abortTurn();
      session.loopState = "idle";
    }

    // Kill creator CLI process
    if (session.cliProcess) {
      try { session.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
      const proc = session.cliProcess;
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 5000);
      session.cliProcess = undefined;
    }

    // Kill evaluator process if running
    if (session.evalProcess) {
      try { session.evalProcess.kill("SIGTERM"); } catch { /* dead */ }
      const evalProc = session.evalProcess;
      setTimeout(() => { try { evalProc.kill("SIGKILL"); } catch { /* dead */ } }, 5000);
      session.evalProcess = undefined;
    }

    session.idle = true;
    this.broadcastToBrowsers(workId, { event: "session_killed", data: { workId } });
    return true;
  }

  killTrendSession(sessionKey: string): boolean {
    if (!sessionKey.startsWith("trends_")) return false;
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    if (session.cliProcess) {
      try { session.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
      session.cliProcess = undefined;
    }
    this.broadcastToBrowsers(sessionKey, {
      event: "research_error",
      data: { message: "用户取消" },
    });
    this.cleanupTrendSession(sessionKey);
    return true;
  }

  getSession(workId: string): WsSession | undefined {
    return this.sessions.get(workId);
  }

  /**
   * Register a listener for session events. Returns cleanup function.
   * Used by TestRunner to wait for events without polling.
   */
  onSessionEvent(workId: string, callback: (event: string, data: unknown) => void): () => void {
    if (!this.eventListeners.has(workId)) {
      this.eventListeners.set(workId, new Set());
    }
    this.eventListeners.get(workId)!.add(callback);
    return () => {
      this.eventListeners.get(workId)?.delete(callback);
    };
  }

  getAllSessions(): Map<string, WsSession> {
    return this.sessions;
  }

  /**
   * After trend session completes, read the agent-written data.json and
   * copy it to the dated YAML cache so GET /api/trends/:platform picks it up.
   * Also read report.md and broadcast it to the frontend.
   */
  private async finalizeTrendData(sessionKey: string): Promise<void> {
    const platform = sessionKey.split("_")[1] ?? "unknown";
    const trendsDir = join(homedir(), ".autoviral", "trends", platform);
    const dataFile = join(trendsDir, "data.json");
    const reportFile = join(trendsDir, "report.md");

    try {
      // Read the JSON data the agent wrote
      const raw = await readFile(dataFile, "utf-8");
      const data = JSON.parse(raw);
      if (data.topics && Array.isArray(data.topics)) {
        // Save as dated YAML for the trends API
        const dateStr = new Date().toISOString().slice(0, 10);
        await writeFile(
          join(trendsDir, `${dateStr}.yaml`),
          yaml.dump(data, { lineWidth: -1 }),
          "utf-8"
        );
      }
    } catch {
      // Agent may not have written valid data.json — fall back to stdout parsing
    }

    // Read report and broadcast to frontend
    try {
      const report = await readFile(reportFile, "utf-8");
      if (report.trim()) {
        this.broadcastToBrowsers(sessionKey, {
          event: "research_report",
          data: { report },
        });
      }
    } catch {
      // No report file — that's fine
    }
  }

  private cleanupTrendSession(sessionKey: string): void {
    this.broadcastToBrowsers(sessionKey, {
      event: "session_closed",
      data: { sessionKey },
    });
    const session = this.sessions.get(sessionKey);
    if (session) {
      for (const ws of session.browserSockets) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
    setTimeout(() => {
      this.sessions.delete(sessionKey);
    }, 5000);
  }

  // ── Browser WebSocket handler ────────────────────────────────────────────

  private async handleBrowserConnection(workId: string, ws: WebSocket): Promise<void> {
    const session = this.ensureSession(workId);
    session.browserSockets.add(ws);

    // Load persisted chat history from disk if session has no in-memory history
    if (session.messageHistory.length === 0) {
      try {
        const persisted = await loadWorkChat(workId);
        if ((persisted as any)?.blocks && Array.isArray((persisted as any).blocks)) {
          session.messageHistory = (persisted as any).blocks;
        }
      } catch { /* no persisted chat */ }
    }

    // Load persisted cliSessionId from work.yaml if not already set
    if (!session.cliSessionId) {
      try {
        const work = await getWork(workId);
        if (work?.cliSessionId) {
          session.cliSessionId = work.cliSessionId;
        }
      } catch { /* ignore */ }
    }

    ws.send(JSON.stringify({
      event: "session_state",
      data: {
        workId,
        connected: !!session.cliProcess,
        idle: session.idle,
        cliSessionId: session.cliSessionId,
      },
      timestamp: new Date().toISOString(),
    }));

    // Replay chat history so browser can reconstruct conversation
    if (session.messageHistory.length > 0) {
      ws.send(JSON.stringify({
        event: "message_history",
        data: { blocks: session.messageHistory },
        timestamp: new Date().toISOString(),
      }));
    }

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === "send" && typeof msg.text === "string") {
          await this.sendMessage(workId, msg.text);
        }
      } catch { /* invalid JSON */ }
    });

    ws.on("close", () => {
      session.browserSockets.delete(ws);
      if (session.browserSockets.size === 0 && session.cliProcess) {
        // 浏览器全断后的 CLI 处理:60 秒重连宽限(此前 1s 就 SIGTERM,关页即杀创作会话,
        // 回合中断 → advance 永远不来 → 状态卡死重跑 —— 2026-08-06 根因)。
        // 宽限到期时若 CLI 仍在活跃输出(长回合进行中),继续宽限而不是杀。
        const graceMs = session.workId.startsWith("trends_") ? 3000 : 60_000;
        const tryKill = () => {
          if (session.browserSockets.size > 0 || !session.cliProcess) return;
          const activeRecently = Date.now() - (session.lastActivityAt ?? 0) < graceMs;
          if (activeRecently && !session.workId.startsWith("trends_")) {
            setTimeout(tryKill, graceMs); // 活任务不杀,继续观察
            return;
          }
          try { session.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
          session.cliProcess = undefined;
          if (session.workId.startsWith("trends_")) {
            this.cleanupTrendSession(session.workId);
          } else {
            session.idle = true;
            this.broadcastToBrowsers(session.workId, { event: "cli_exited", data: { workId: session.workId } });
          }
        };
        setTimeout(tryKill, graceMs);
      }
    });
    ws.on("error", () => session.browserSockets.delete(ws));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * 回合收尾（从 spawnCli 的 result 分支抽出，2026-08-17 LLM 直连改造）：
   * 广播 turn_complete + saveWorkChat 落盘 + memory 同步 + steps/<step>.json 摘要。
   * CLI 路径与 API loop 路径（ws-compat）共用，保证两侧行为逐字一致。
   */
  finalizeTurn(session: WsSession, resultText: string): void {
    this.broadcastToBrowsers(session.workId, {
      event: "turn_complete",
      data: {
        workId: session.workId,
        idle: true,
        result: resultText,
        sessionId: session.cliSessionId,
        historyLength: session.messageHistory.length,
      },
    });
    // Persist chat to disk (survives server restart)
    if (!session.workId.startsWith("trends_")) {
      saveWorkChat(session.workId, { blocks: session.messageHistory }).catch(() => {});
    }
    // Real-time memory sync — assistant text (complete turn, not fragments)
    if (!session.workId.startsWith("trends_") && resultText) {
      getWork(session.workId).then(w => {
        if (!w) return;
        const activeStep = Object.entries(w.pipeline).find(([, s]) => s.status === "active");
        if (activeStep) {
          syncMessage(session.workId, w.title, activeStep[0], "assistant", resultText).catch(() => {});
        }
      }).catch(() => {});
    }
    // Auto-save step history from backend (doesn't rely on frontend)
    // Only save the NEW messages from this turn (not entire history)
    if (!session.workId.startsWith("trends_") && resultText) {
      getWork(session.workId).then(w => {
        if (!w) return;
        const activeStep = Object.entries(w.pipeline).find(([, s]) => s.status === "active");
        if (activeStep) {
          const [stepKey, stepInfo] = activeStep;
          // Build blocks from this turn only: the last user message + resultText
          const lastUserMsg = [...session.messageHistory].reverse().find(m => m.type === "user");
          const blocks: Array<{type: string; text: string}> = [];
          if (lastUserMsg) blocks.push({ type: "user", text: lastUserMsg.text });
          blocks.push({ type: "text", text: resultText });
          // Append to existing step history (don't overwrite)
          loadStepHistory(session.workId, stepKey).then(existing => {
            const existingBlocks = (existing as any)?.blocks ?? [];
            saveStepHistory(session.workId, stepKey, {
              stepKey,
              stepName: stepInfo.name,
              completedAt: new Date().toISOString(),
              blocks: [...existingBlocks, ...blocks],
            }).catch(() => {});
          }).catch(() => {
            // No existing history, save fresh
            saveStepHistory(session.workId, stepKey, {
              stepKey,
              stepName: stepInfo.name,
              completedAt: new Date().toISOString(),
              blocks,
            }).catch(() => {});
          });
        }
      }).catch(() => {});
    }
  }

  /** 供 ws-compat（API loop 路径）使用：推入 ChatBlock（历史+jsonl+防抖快照）并广播事件 */
  pushBlock(session: WsSession, block: ChatBlock, event: string, data: unknown): void {
    session.messageHistory.push(block);
    this.appendToChatLog(session.workId, block);
    this.scheduleIncrementalSave(session.workId);
    this.broadcastToBrowsers(session.workId, { event, data });
  }

  broadcastToBrowsers(workId: string, payload: { event: string; data: unknown }): void {
    const session = this.sessions.get(workId);
    if (!session) return;

    const message = JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
    });

    for (const ws of session.browserSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }

    // Notify in-process event listeners (used by TestRunner)
    const listeners = this.eventListeners.get(workId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(payload.event, payload.data); } catch { /* listener error shouldn't crash bridge */ }
      }
    }
  }

  private extractWorkId(url: string): string | null {
    const match = url.match(/^\/ws\/browser\/([^/?]+)/);
    return match ? match[1] : null;
  }
}
