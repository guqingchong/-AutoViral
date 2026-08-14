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
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import yaml from "js-yaml";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { appendFile } from "node:fs/promises";
import { logBridge, logBridgeDebug } from "./logger.js";
import { loadConfig, dataDir } from "./config.js";
import { getWork, updateWork, saveStepHistory, loadStepHistory, saveWorkChat, loadWorkChat, type Work, type PipelineStep, type EvalResult } from "./work-store.js";
import { listSharedAssets } from "./shared-assets.js";
import { MemoryClient } from "./memory.js";
import { syncMessage } from "./memory-sync.js";

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

// ── Cross-platform CLI resolution ──────────────────────────────────────────

/** Resolve the actual Claude CLI executable path.
 *  On Windows, npm installs a .cmd wrapper that cannot be spawn'd directly
 *  (Node.js v20+ throws EINVAL). We find the real .exe under the global
 *  node_modules tree so arguments are passed verbatim without shell parsing.
 */
export function resolveClaudeCommand(): string {
  if (process.platform !== "win32") return "claude";

  try {
    const npmPrefix = execSync("npm prefix -g", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const exePath = join(
      npmPrefix,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    if (existsSync(exePath)) return exePath;
  } catch { /* ignore */ }

  return "claude";
}

// ── WsBridge ─────────────────────────────────────────────────────────────────

/** 活性宽限期：回合结束后 advance 续命/评审 spawn 有数十秒空窗,
 *  在此期间无 cliProcess 属正常,宽限期内仍视为活跃,防止 queue/watchdog 误判假死重复 spawn */
const ACTIVITY_GRACE_MS = 120_000;

export class WsBridge {
  private sessions: Map<string, WsSession> = new Map();
  private eventListeners: Map<string, Set<(event: string, data: unknown) => void>> = new Map();
  private chatSaveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 每作品的 spawn 串行锁:createSession/sendMessage/stale 重试的 kill-then-spawn
   *  必须互斥,否则并发触发会产生脱离跟踪的孤儿 CLI 进程(2026-08-06 根因) */
  private spawnChains: Map<string, Promise<void>> = new Map();
  private browserWss: WebSocketServer;

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

  /** 作品是否活跃:有存活进程,或最近 ACTIVITY_GRACE_MS 内有 CLI 活动。
   *  queue runner / watchdog 的存活判定必须用这个,而不是只看 cliProcess —
   *  -p 单回合模式下进程每回合退出是常态,纯内存判定会误判假死(2026-08-06 根因) */
  isWorkActive(workId: string): boolean {
    const s = this.sessions.get(workId);
    if (!s) return false;
    if (s.cliProcess || s.evalProcess) return true;
    return Date.now() - (s.lastActivityAt ?? 0) < ACTIVITY_GRACE_MS;
  }

  constructor(_serverPort: number) {
    this.browserWss = new WebSocketServer({ noServer: true });
    this.browserWss.on("connection", (ws, req) => {
      const workId = this.extractWorkId(req.url ?? "");
      if (workId) this.handleBrowserConnection(workId, ws);
    });
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
    return false;
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

    const platforms = work.platforms.join(", ");

    return `## 系统第一原则：质量优先

- 宁可不交付，不可降质交付。如果所有路径都会导致不可接受的质量损失，停下来告知用户，而不是静默降质出一个"勉强能用"的结果
- 降级必须最小让步：受阻时逐级尝试替代方案，每一级都优先保住对最终内容质量影响最大的环节
- 降质决策必须透明：换模型、换生成方式、跳过步骤等任何涉及质量降级的决策，必须告知用户并获得确认，不可静默执行
- 质量检测前置：批量生成前做样本测试，执行前检测环境能力，把问题拦在源头而非事后补救

---

你是AutoViral创作助手，正在帮用户创建一个${work.type}作品。
目标平台：${platforms}
当前阶段：${currentStep}

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
- 生图：脚本工具 python3 ~/.claude/skills/asset-generation/scripts/openrouter_generate.py 或 jimeng_generate.py（详见 asset-generation skill）
- 生视频：调用 curl http://localhost:${port}/api/generate/video 或使用即梦脚本
- 合成：使用ffmpeg命令剪辑视频（拼接片段+字幕+配乐+转场）
- 字幕管线（强制）：
  1. **生成字幕文件**：使用 python3 ~/.claude/skills/content-assembly/scripts/caption_generate.py 生成 ASS 字幕（支持 douyin-highlight/xhs-soft/funny/minimal 等预设风格 + 逐词高亮 karaoke）。如果你有手动时间戳 JSON，也可以用 --timestamps 模式；否则用 --input 自动语音识别模式
  2. **烧录字幕到视频（默认路径，必须）**：使用 ffmpeg 原生 ass 滤镜烧录，单次编码、音频直拷：
     ffmpeg -i composited.mp4 -vf "ass=subs.ass:fontsdir='C\\:/Users/顾庆冲/.autoviral/fonts'" -c:v libx264 -preset veryfast -crf 20 -c:a copy -y output/final.mp4
     Windows 下盘符冒号需转义（C\\:/）；路径含中文时先 cd 到作品目录用相对路径。**禁止用 ffmpeg drawtext 或手写 Pillow 方案**
  3. **备用路径**：仅当输入是 SRT 且不需要 karaoke、或 ffmpeg 无 libass 时，才用 python3 ~/.claude/skills/content-assembly/scripts/subtitle_burn.py（注意：它会剥掉 {\\kf} karaoke 标签并忽略 ASS MarginV，ASS+karaoke 场景禁用）
  4. **字体**：必须使用 ~/.autoviral/fonts/ 下的高质量字体（NotoSansCJKsc-Bold.otf，家族名 Noto Sans CJK SC），禁止使用系统字体；libass 日志出现 fontselect 回退系统字体时必须停下来修正 Fontname
  5. **布局安全区（强制）**：字幕带（MarginV=430，y≈1390–1550）与数字人/字卡 overlay 坐标必须由同一份布局常量计算且断言不相交；数字人分窗固定预设 scale=420:-2,pad=428:754 + overlay=616:200；合成后在 10%/50%/90% 抽帧复核遮挡
- BGM 配乐（强制）：
  1. BGM 只能来自以下渠道：公共素材库音乐（/api/shared-assets 中 music 类）、curl http://localhost:${port}/api/generate/music（MiniMax music-2.6，传 duration 自动补齐时长，可按情绪/BPM/乐器写 prompt）、yt-dlp 下载免版权音乐。**禁止用 ffmpeg 合成正弦波/白噪声/棕噪声等充当 BGM**——这属于静默降质，违反质量第一原则
  2. BGM 时长必须 ≥ 视频时长；接缝处必须交叉淡化，禁止生硬重复
  3. 混音用响度锚定（禁止拍脑袋 volume 比例）：旁白轨 loudnorm=I=-15:TP=-1.5:LRA=11，BGM 轨 loudnorm=I=-34:TP=-3:LRA=11（低于旁白约 19dB）再混入；BGM 能量强时再降 3dB；旁白清晰度永远优先
  4. 以上渠道全部不可用时，停下来明确报告"无可用 BGM 渠道"，不得在方案中承诺不存在的资源，也不得即兴合成
- 资源可达性检查（必做）：规划阶段引用任何外部资源通道（Pixabay Music、Pexels、Unsplash、Lyria、即梦等）前，先验证该通道已配置可用（config 中有 apiKey / 接口实测可通）。**未配置的通道不得写进方案**，直接改用已配置的替代通道
- 公共素材：通过 curl http://localhost:${port}/api/shared-assets 查看可用素材
- 流水线管理：调用 curl -X POST http://localhost:${port}/api/works/${work.id}/pipeline/advance 更新流水线状态

## 前置检测（必做）

**素材生成阶段第一步**：在任何生图/生视频操作前，必须先运行环境检测：
\`\`\`
python3 ~/.claude/skills/asset-generation/scripts/check_environment.py --format summary
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

## 规则
- 调研阶段：如果用户指定了方向，围绕该方向深入调研；否则广泛调研热门趋势
- 每生成一个素材前，先描述计划，等用户确认
- 素材生成后展示预览链接，等用户反馈
- 短视频制作：先生成首帧图片→用首帧图生成视频片段→ffmpeg剪辑合成
- 可随时引用公共素材库中的人物、配乐等素材
- 只支持抖音和小红书平台
- 不要在未经用户确认的情况下自动跳转到下一阶段`;
  }

  /**
   * Start a new CLI session. Loads work context, builds system prompt,
   * then spawns `claude -p <prompt> --output-format stream-json --verbose`.
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

    const session: WsSession = {
      workId,
      idle: false,
      browserSockets: existing?.browserSockets ?? new Set(),
      messageHistory: existing?.messageHistory ?? [],
      model,
    };
    this.sessions.set(workId, session);

    // Load persisted chat history (survives server restart)
    // Try JSONL first (new format), fall back to JSON (legacy)
    try {
      const jsonlPath = join(dataDir, "works", session.workId, "chat.jsonl");
      const raw = await readFile(jsonlPath, "utf-8");
      const blocks: ChatBlock[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { blocks.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      if (blocks.length > 0) session.messageHistory = blocks;
    } catch {
      // No JSONL — try legacy JSON
      try {
        const existing = await loadWorkChat(session.workId);
        if ((existing as any)?.blocks && Array.isArray((existing as any).blocks)) {
          session.messageHistory = (existing as any).blocks;
          // Migrate: write as JSONL for future reads
          const jsonlPath = join(dataDir, "works", session.workId, "chat.jsonl");
          const jsonlContent = (existing as any).blocks.map((b: ChatBlock) => JSON.stringify(b)).join("\n") + "\n";
          writeFile(jsonlPath, jsonlContent, "utf-8").catch(() => {});
        }
      } catch { /* ignore */ }
    }

    // Load persisted cliSessionId from work.yaml (survives server restart)
    let savedSessionId: string | undefined;
    try {
      const work = await getWork(workId);
      if (work?.cliSessionId) {
        savedSessionId = work.cliSessionId;
        session.cliSessionId = savedSessionId;
      }
    } catch { /* ignore */ }

    if (savedSessionId) {
      // Resume existing conversation — agent keeps full context
      this.spawnCli(session, initialPrompt, savedSessionId);
    } else {
      // First time — build system prompt with full context
      let systemPrompt = initialPrompt;
      try {
        const work = await getWork(workId);
        if (work) {
          const contextPrompt = await this.buildSystemPrompt(work);
          systemPrompt = contextPrompt + "\n\n---\n\n用户消息：" + initialPrompt;
        }
      } catch { /* fall back to plain prompt */ }
      this.spawnCli(session, systemPrompt);
    }

    return session;
  }

  /**
   * Create an ephemeral trend research session.
   * Uses sonnet model, auto-kills after 180s, filters CLI events into simplified research events.
   */
  async createTrendSession(sessionKey: string, prompt: string): Promise<WsSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.cliProcess) {
      try { existing.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
    }

    const session: WsSession = {
      workId: sessionKey,
      idle: false,
      browserSockets: existing?.browserSockets ?? new Set(),
      messageHistory: [],
      model: "sonnet",
    };
    this.sessions.set(sessionKey, session);

    this.spawnCli(session, prompt);

    // Auto-kill after 180s
    setTimeout(() => {
      if (session.cliProcess) {
        try { session.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
        session.cliProcess = undefined;
        // Still try to read files even on timeout — agent may have written data.json
        this.finalizeTrendData(sessionKey).catch(() => {}).finally(() => {
          this.broadcastToBrowsers(sessionKey, {
            event: "research_error",
            data: { message: "搜索超时，请稍后重试" },
          });
          this.cleanupTrendSession(sessionKey);
        });
      }
    }, 180000);

    this.broadcastToBrowsers(sessionKey, {
      event: "research_started",
      data: { platform: sessionKey.split("_")[1] ?? "unknown" },
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

    // If CLI is still running (shouldn't normally be, but just in case)
    if (session.cliProcess) {
      try { session.cliProcess.kill("SIGTERM"); } catch { /* dead */ }
      session.cliProcess = undefined;
    }

    // Try to resume: check in-memory first, then persisted in work.yaml
    let resumeId = session.cliSessionId;
    if (!resumeId) {
      try {
        const work = await getWork(workId);
        if (work?.cliSessionId) {
          resumeId = work.cliSessionId;
          session.cliSessionId = resumeId;
        }
      } catch { /* ignore */ }
    }

    if (resumeId) {
      this.spawnCli(session, text, resumeId);
    } else {
      // No session to resume — build full context prompt so agent knows the project
      let prompt = text;
      try {
        const work = await getWork(workId);
        if (work) {
          const contextPrompt = await this.buildSystemPrompt(work);
          prompt = contextPrompt + "\n\n---\n\n用户消息：" + text;
        }
      } catch { /* fall back to plain text */ }
      this.spawnCli(session, prompt);
    }

    session.idle = false;
    this.broadcastToBrowsers(workId, {
      event: "session_state",
      data: { idle: false },
    });

    return true;
  }

  killSession(workId: string): boolean {
    const session = this.sessions.get(workId);
    if (!session) return false;

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

  // ── CLI spawn ────────────────────────────────────────────────────────────

  private spawnCli(session: WsSession, prompt: string, resumeSessionId?: string): void {
    logBridge("spawn_cli", session.workId, { model: session.model, resume: resumeSessionId });
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    // 始终显式指定模型：否则 CLI 会回落到用户 settings.json 的默认 model
    // （主会话 /model 设置如 "k3[1m]" 对 AutoViral spawn 的独立 CLI 进程无效，
    //  会导致每个 agent 回合立即报错退出、流水线假死 —— 2026-07-17 根因）
    args.push("--model", session.model ?? "sonnet");

    const cliCmd = resolveClaudeCommand();
    const proc = spawn(cliCmd, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: "cli",
        AUTOVIRAL_PROJECT_DIR: process.cwd(),
      },
    });

    session.cliProcess = proc;
    session.lastActivityAt = Date.now();

    // Accumulate assistant text chunks for this turn
    let turnText = "";
    let lastEventWasToolResult = false;
    // stderr 尾部累积：resume 失败等 CLI 致命错误的真实原因只出现在 stderr，
    // 此前只广播给浏览器、不进日志，导致"会话静默死亡"无法诊断（2026-07-21）
    let stderrTail = "";

    // Parse NDJSON from stdout
    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      session.lastActivityAt = Date.now();
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: NdjsonMessage = JSON.parse(line);

          // Trend session event filtering
          if (session.workId.startsWith("trends_")) {
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content as Array<Record<string, unknown>>) {
                if (block.type === "tool_use" && block.name === "WebSearch") {
                  const input = block.input as Record<string, unknown> | undefined;
                  this.broadcastToBrowsers(session.workId, {
                    event: "search_query",
                    data: { query: (input?.query as string) ?? "" },
                  });
                  lastEventWasToolResult = false;
                }
              }
            }
            if (msg.type === "user" && (msg as Record<string, unknown>).message) {
              const userMsg = (msg as Record<string, unknown>).message as Record<string, unknown>;
              const content = userMsg.content as Array<Record<string, unknown>> | undefined;
              if (content) {
                for (const block of content) {
                  if (block.type === "tool_result") {
                    const resultText = typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content);
                    const summary = resultText.slice(0, 80) || "搜索完成";
                    this.broadcastToBrowsers(session.workId, {
                      event: "search_result",
                      data: { summary },
                    });
                  }
                }
                lastEventWasToolResult = true;
              }
            }
          }

          // system.init — capture session ID and persist to work.yaml
          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              session.cliSessionId = msg.session_id;
              // Persist so we can --resume after server restart
              updateWork(session.workId, { cliSessionId: msg.session_id }).catch(() => {});
            }
            this.broadcastToBrowsers(session.workId, {
              event: "session_ready",
              data: { workId: session.workId, cliSessionId: session.cliSessionId },
            });
            continue;
          }

          // assistant — forward all content blocks to browsers
          if (msg.type === "assistant" && msg.message?.content) {
            const blocks = msg.message.content as Array<Record<string, unknown>>;
            const blockTypes = blocks.map((b: Record<string, unknown>) => b.type).join(",");
            logBridgeDebug("cli_assistant_message", session.workId, {
              messageId: msg.message.id,
              blockTypes,
              blockCount: blocks.length,
            });
            for (const block of blocks) {
              if (block.type === "text" && block.text) {
                if (session.workId.startsWith("trends_") && lastEventWasToolResult) {
                  this.broadcastToBrowsers(session.workId, {
                    event: "analyzing",
                    data: {},
                  });
                  lastEventWasToolResult = false;
                }
                turnText += block.text as string;
                if (!session.workId.startsWith("trends_")) {
                  const textBlock: ChatBlock = { type: "text", text: block.text as string, timestamp: new Date().toISOString() };
                  session.messageHistory.push(textBlock);
                  this.appendToChatLog(session.workId, textBlock);
                  this.scheduleIncrementalSave(session.workId);
                }
                this.broadcastToBrowsers(session.workId, {
                  event: "assistant_text",
                  data: { workId: session.workId, text: block.text },
                });
              } else if (block.type === "thinking" && block.thinking) {
                if (!session.workId.startsWith("trends_")) {
                  const thinkBlock: ChatBlock = { type: "thinking", text: block.thinking as string, collapsed: true };
                  session.messageHistory.push(thinkBlock);
                  this.appendToChatLog(session.workId, thinkBlock);
                  this.scheduleIncrementalSave(session.workId);
                }
                this.broadcastToBrowsers(session.workId, {
                  event: "assistant_thinking",
                  data: { workId: session.workId, text: block.thinking },
                });
              } else if (block.type === "tool_use") {
                if (!session.workId.startsWith("trends_")) {
                  const toolBlock: ChatBlock = { type: "tool_use", text: JSON.stringify(block.input), toolName: block.name as string };
                  session.messageHistory.push(toolBlock);
                  this.appendToChatLog(session.workId, toolBlock);
                  this.scheduleIncrementalSave(session.workId);
                }
                this.broadcastToBrowsers(session.workId, {
                  event: "tool_use",
                  data: { workId: session.workId, name: block.name, input: block.input },
                });
              }
            }
            continue;
          }

          // user (tool results) — forward to browsers
          if (msg.type === "user" && (msg as Record<string, unknown>).message) {
            const userMsg = (msg as Record<string, unknown>).message as Record<string, unknown>;
            const content = userMsg.content as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  const resultContent = typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                  if (!session.workId.startsWith("trends_")) {
                    const trBlock: ChatBlock = { type: "tool_result", text: resultContent, collapsed: true };
                    session.messageHistory.push(trBlock);
                    this.appendToChatLog(session.workId, trBlock);
                    this.scheduleIncrementalSave(session.workId);
                  }
                  this.broadcastToBrowsers(session.workId, {
                    event: "tool_result",
                    data: { workId: session.workId, content: resultContent },
                  });
                }
              }
            }
            continue;
          }

          // result — turn complete
          if (msg.type === "result") {
            session.idle = true;
            const resultText = typeof msg.result === "string" && msg.result
              ? msg.result
              : turnText;
            logBridge("turn_complete", session.workId, {
              hasResult: !!(typeof msg.result === "string" && msg.result),
              resultLen: typeof msg.result === "string" ? msg.result.length : 0,
              turnTextLen: turnText.length,
              resultPreview: (resultText || "").slice(0, 150),
            });
            // Update cliSessionId from result if present
            if (msg.session_id) {
              session.cliSessionId = msg.session_id;
            }
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
            continue;
          }

          // Forward everything else
          this.broadcastToBrowsers(session.workId, {
            event: "cli_event",
            data: msg,
          });
        } catch {
          // Non-JSON line, ignore
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.trim()) {
        stderrTail = (stderrTail + text).slice(-800);
        this.broadcastToBrowsers(session.workId, {
          event: "cli_stderr",
          data: { text },
        });
      }
    });

    proc.on("exit", (code, signal) => {
      logBridge("cli_exit", session.workId, { code, signal, turnTextLen: turnText.length, stderrTail: stderrTail.slice(-300) });

      // If CLI exits with code 1 and produced no output, the resume session is likely stale
      // (e.g. computer restarted while session file still marks it as "busy"). Clear it so
      // next spawn creates a fresh session.
      if (code === 1 && turnText.length === 0 && session.cliSessionId) {
        logBridge("cli_stale_session_cleared", session.workId, { cliSessionId: session.cliSessionId });
        session.cliSessionId = undefined;
        // 同步清 SQLite（此前只清了 legacy work.yaml，而 createSession 读的是
        // works.cli_session_id —— stale ID 残留导致每次重建都 resume 失败、死循环）
        updateWork(session.workId, { cliSessionId: "" }).catch(() => {});
        // yaml.dump ignores undefined values, so we must delete the field directly from work.yaml
        const workPath = join(dataDir, "works", session.workId, "work.yaml");
        readFile(workPath, "utf-8")
          .then((raw) => {
            const workData = yaml.load(raw) as Record<string, unknown> | null;
            if (workData && "cliSessionId" in workData) {
              delete workData.cliSessionId;
              return writeFile(workPath, yaml.dump(workData, { lineWidth: -1, sortKeys: false }), "utf-8");
            }
          })
          .catch(() => {});

        // 关键：自动以全新会话重试（不 resume）。此前清理后不重试，打回重做/
        // 会话重建等场景下 agent 从未真正启动，作品永久卡在当前阶段。
        // 限 1 次防循环：若 CLI 本身故障（非 stale），新会话退出时无
        // cliSessionId 可清则不再重试。
        const retried = (session as WsSession & { staleRetried?: boolean }).staleRetried;
        if (!retried && !session.workId.startsWith("trends_")) {
          (session as WsSession & { staleRetried?: boolean }).staleRetried = true;
          logBridge("cli_stale_retry_fresh", session.workId, {});
          session.cliProcess = undefined;
          // 与 queue resume / advance 续命的 spawn 互斥，避免同一作品双 spawn
          void this.withSpawnLock(session.workId, async () => {
            if (session.cliProcess) return; // 已被其他路径接管，不再重试
            try {
              const work = await getWork(session.workId);
              const freshPrompt = work
                ? (await this.buildSystemPrompt(work)) + "\n\n---\n\n用户消息：" + prompt
                : prompt;
              this.spawnCli(session, freshPrompt);
            } catch {
              this.spawnCli(session, prompt);
            }
          });
          return; // 新进程已接管 session.cliProcess，不走下方退出收尾
        }
      }

      session.cliProcess = undefined;
      session.idle = true;
      if (session.workId.startsWith("trends_")) {
        if (code === 0) {
          // Read agent-written files and broadcast report before done event
          this.finalizeTrendData(session.workId).catch(() => {}).finally(() => {
            this.broadcastToBrowsers(session.workId, {
              event: "research_done",
              data: { platform: session.workId.split("_")[1] ?? "unknown" },
            });
            this.cleanupTrendSession(session.workId);
          });
        } else {
          this.broadcastToBrowsers(session.workId, {
            event: "research_error",
            data: { message: `CLI exited with code ${code}` },
          });
          this.cleanupTrendSession(session.workId);
        }
      } else {
        this.broadcastToBrowsers(session.workId, {
          event: "cli_exited",
          data: { workId: session.workId, code, signal },
        });
        // Persist chat to disk on CLI exit
        saveWorkChat(session.workId, { blocks: session.messageHistory }).catch(() => {});
      }
    });

    proc.on("error", (err) => {
      logBridge("cli_error", session.workId, { error: err.message });
      this.broadcastToBrowsers(session.workId, {
        event: "cli_error",
        data: { workId: session.workId, error: err.message },
      });
    });
  }

  /**
   * Spawn an evaluator CLI agent for quality review.
   * Routes messages with source:"evaluator" and parses structured eval results.
   */
  spawnEvaluator(
    session: WsSession,
    prompt: string,
    resumeEvalSessionId?: string,
  ): Promise<EvalResult> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];

      if (resumeEvalSessionId) {
        args.push("--resume", resumeEvalSessionId);
      }

      // 始终显式指定模型（同 spawnCli，避免回落到用户默认 model 导致回合即死）
      args.push("--model", session.model ?? "sonnet");

      const cliCmd = resolveClaudeCommand();
      const proc = spawn(cliCmd, args, {
        cwd: homedir(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli", AUTOVIRAL_PROJECT_DIR: process.cwd() },
      });

      // Store on session so killSession() can kill it
      session.evalProcess = proc;

      let turnText = "";
      let buffer = "";
      let resolved = false;

      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: NdjsonMessage = JSON.parse(line);

            // Capture evaluator session ID
            if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
              session.evalSessionId = msg.session_id;
            }

            // Forward assistant blocks with source: "evaluator"
            if (msg.type === "assistant" && msg.message?.content) {
              const blocks = msg.message.content as Array<Record<string, unknown>>;
              for (const block of blocks) {
                if (block.type === "text" && block.text) {
                  turnText += block.text as string;
                  const eb: ChatBlock = { type: "text", text: block.text as string, source: "evaluator", timestamp: new Date().toISOString() };
                  session.messageHistory.push(eb);
                  this.appendToChatLog(session.workId, eb);
                  this.scheduleIncrementalSave(session.workId);
                  this.broadcastToBrowsers(session.workId, {
                    event: "assistant_text",
                    data: { workId: session.workId, text: block.text, source: "evaluator" },
                  });
                } else if (block.type === "thinking" && block.thinking) {
                  const eb: ChatBlock = { type: "thinking", text: block.thinking as string, source: "evaluator", collapsed: true };
                  session.messageHistory.push(eb);
                  this.appendToChatLog(session.workId, eb);
                  this.broadcastToBrowsers(session.workId, {
                    event: "assistant_thinking",
                    data: { workId: session.workId, text: block.thinking, source: "evaluator" },
                  });
                } else if (block.type === "tool_use") {
                  const eb: ChatBlock = { type: "tool_use", text: JSON.stringify(block.input), toolName: block.name as string, source: "evaluator" };
                  session.messageHistory.push(eb);
                  this.appendToChatLog(session.workId, eb);
                  this.scheduleIncrementalSave(session.workId);
                  this.broadcastToBrowsers(session.workId, {
                    event: "tool_use",
                    data: { workId: session.workId, name: block.name, input: block.input, source: "evaluator" },
                  });
                }
              }
            }

            // Forward tool results with source: "evaluator"
            if (msg.type === "user" && (msg as any).message?.content) {
              const content = (msg as any).message.content as Array<Record<string, unknown>>;
              for (const block of content) {
                if (block.type === "tool_result") {
                  const resultContent = typeof block.content === "string"
                    ? block.content : JSON.stringify(block.content);
                  const eb: ChatBlock = { type: "tool_result", text: resultContent, source: "evaluator", collapsed: true };
                  session.messageHistory.push(eb);
                  this.appendToChatLog(session.workId, eb);
                  this.scheduleIncrementalSave(session.workId);
                  this.broadcastToBrowsers(session.workId, {
                    event: "tool_result",
                    data: { workId: session.workId, content: resultContent, source: "evaluator" },
                  });
                }
              }
            }

            // result — eval turn complete, parse JSON result
            if (msg.type === "result") {
              if (msg.session_id) {
                session.evalSessionId = msg.session_id;
              }
              const resultText = typeof msg.result === "string" && msg.result ? msg.result : turnText;

              // Parse eval result JSON from response
              let evalResult: EvalResult;
              try {
                // Try extracting JSON from markdown code block first
                const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                  evalResult = JSON.parse(jsonMatch[1]);
                } else {
                  // Try parsing entire text as JSON
                  evalResult = JSON.parse(resultText);
                }
              } catch {
                // Fallback: if we can't parse JSON, create a default pass result
                evalResult = {
                  step: session.evalStep ?? "unknown",
                  attempt: 1,
                  verdict: "pass" as const,
                  scores: {},
                  issues: [],
                  suggestions: [],
                  timestamp: new Date().toISOString(),
                };
              }

              // Persist chat
              saveWorkChat(session.workId, { blocks: session.messageHistory }).catch(() => {});

              if (!resolved) {
                resolved = true;
                resolve(evalResult);
              }
            }
          } catch { /* ignore non-JSON lines */ }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        if (text.trim()) {
          this.broadcastToBrowsers(session.workId, {
            event: "cli_stderr",
            data: { text, source: "evaluator" },
          });
        }
      });

      proc.on("exit", (code) => {
        session.evalProcess = undefined;
        if (!resolved) {
          resolved = true;
          if (code !== 0) {
            reject(new Error(`Evaluator exited with code ${code}`));
          } else {
            // If exited cleanly but no result parsed, return default pass
            resolve({
              step: session.evalStep ?? "unknown",
              attempt: 1,
              verdict: "pass" as const,
              scores: {},
              issues: [],
              suggestions: [],
              timestamp: new Date().toISOString(),
            });
          }
        }
      });

      proc.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
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
