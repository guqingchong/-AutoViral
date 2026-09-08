/**
 * 评审 loop(API 版)+ 评审结果解析共享(2026-08-17 LLM 直连架构 P2-T1)。
 * 设计文档:docs/desigen/02 P2-T1
 *
 * 要点:
 * - parseEvalResultText 从 ws-bridge.spawnEvaluator 抽出(P4-T2 起 CLI 评审删除,仅此 API 路径)
 * - runApiEvaluator:独立 AgentLoop、全新 messages、只读工具子集(buildEvaluatorTools)
 * - 视觉路由:含图片的回合由 loop 切到 visionProvider/visionModel;
 *   优先级 = 评审 provider 自家 visionModel → kimi(2026-08-16 冒烟实证 tools+vision 双支持)
 *   → glm(仅视觉;2026-08-17 探针实证 glm-4v 带 tools 返回空内容,作兜底)
 * - assets/assembly 评审必须看图:无可用视觉模型 → 配置校验期报错(不静默降级为盲评)
 */

import type { Config } from "../config.js";
import type { EvalResult } from "../work-store.js";
import type { LlmProvider } from "../llm/types.js";
import { AgentLoop } from "./loop.js";
import { buildEvaluatorTools } from "./tools/index.js";
import { resolveModelFor, getProvider, getVisionModel } from "../llm/registry.js";
import { createLoopEventSink } from "./ws-compat.js";
import type { WsBridge, WsSession } from "../ws-bridge.js";

/** 从评审输出文本提取 EvalResult(```json 块 > 全文 JSON > 兜底 pass)——与 CLI 路径语义逐字一致 */
export function parseEvalResultText(resultText: string, fallbackStep: string, criteria?: { hardDims?: string[]; minAi?: Record<string, number> }): EvalResult {
  try {
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(resultText);
    return machineCheckVerdict(parsed, fallbackStep, criteria);
  } catch {
    // 2026-08-19 堵假 pass 洞:解析失败兜底 pass 曾让质量门随机放水(w_20260819_1634_cd5
    // material-search 第 3 轮空 scores "pass")。打 __parseFailed 标记,由调用方先重试。
    return {
      step: fallbackStep,
      attempt: 1,
      verdict: "pass" as const,
      scores: {},
      issues: [],
      suggestions: [],
      timestamp: new Date().toISOString(),
      __parseFailed: true,
    } as EvalResult & { __parseFailed?: boolean };
  }
}

/** Q3(方案定稿):从 criteria 文件编译"硬性维度 + min_ai 量化下限"——否定聚合的数据源。
 *  解析格式:`### N. 中文名 (英文key) 【硬性·...】 min_ai: 8`(min_ai 缺省 6)。
 *  hardDims 用英文 key(评审要求按 criteria 的英文 key 输出 scores,双匹配兜底中文名)。 */
export function compileCriteriaMinAi(criteriaText: string): { hardDims: string[]; minAi: Record<string, number> } {
  const hardDims: string[] = [];
  const minAi: Record<string, number> = {};
  const re = /###\s*\d+(?:\.\d+)?\.\s*[^（(]*?\(([a-z0-9_]+)\)\s*【硬性[^】]*】(?:\s*min_ai\s*[:：]\s*(\d+))?/g;
  for (const m of criteriaText.matchAll(re)) {
    const key = m[1];
    hardDims.push(key);
    minAi[key] = m[2] ? Number(m[2]) : 6;
  }
  return { hardDims, minAi };
}
/** 2026-09-01 终审 M2:verdict 机器复核——LLM 写的 verdict 不再原样采信。
 *  归一化(trim/lowercase);"scores 有 <6 分或含 critical 问题但 verdict 写 pass"
 *  的不一致直接改判 fail(幻觉 pass 的结构性防线);反之 scores 全过但 verdict
 *  误写 fail 不翻案(误拒安全方向,走重试)。
 *  Q3(2026-09 施工)扩展:major 未清 / HARD 维度低于 min_ai(否定聚合,不计算加权平均)
 *  一律改判 fail——criteria 参数可选(由调用方 buildEvalPrompt 处传入),缺省不启用。 */
export function machineCheckVerdict(parsed: any, fallbackStep: string, criteria?: { hardDims?: string[]; minAi?: Record<string, number> }): EvalResult {
  const result = parsed as EvalResult;
  const rawVerdict = String(result.verdict ?? "").trim().toLowerCase();
  result.verdict = rawVerdict === "pass" ? "pass" : "fail";
  const scoreVals = Object.values(result.scores ?? {}).map(Number).filter(Number.isFinite);
  const hasLowScore = scoreVals.length > 0 && scoreVals.some((s) => s < 6);
  const hasCritical = (result.issues ?? []).some((i: any) => i?.severity === "critical");
  const hasMajor = (result.issues ?? []).some((i: any) => i?.severity === "major");
  const hardBelow = !!criteria?.hardDims?.length && !!criteria?.minAi &&
    criteria.hardDims.some((d) => {
      const raw = result.scores?.[d];
      // 缺失的维度不算违规(LLM 输出可能未覆盖,交它自行判断);只对"明确输出且低于下限"触发
      if (raw === undefined || raw === null) return false;
      const v = Number(raw);
      return Number.isFinite(v) && v < (criteria.minAi?.[d] ?? 0);
    });
  if (result.verdict === "pass" && (hasLowScore || hasCritical || hasMajor || hardBelow)) {
    const reasons = [
      hasLowScore ? "scores<6" : "", hasCritical ? "critical" : "",
      hasMajor ? "major 未清" : "", hardBelow ? "HARD<min_ai" : "",
    ].filter(Boolean).join("+");
    console.warn(`[eval] verdict 复核改判 fail(${fallbackStep}):${reasons}`);
    result.verdict = "fail";
  }
  return result;
}

/** 评审器硬超时(2026-08-28 批次1.2):超时触发 abortTurn,控制流收敛后由调用方转降级链 */
export class EvalTimeoutError extends Error {
  readonly step: string;
  constructor(step: string, timeoutMs: number) {
    super(`评审器硬超时(${step} 阶段,${Math.round(timeoutMs / 60000)} 分钟未完成)`);
    this.name = "EvalTimeoutError";
    this.step = step;
  }
}

/** 评审输出二次解析仍失败(2026-08-28 批次1.5):此前兜底 pass 是制度化放水通道,改为显式错误进 eval_error 链 */
export class EvalParseError extends Error {
  constructor(step: string) {
    super(`评审输出两次均无法解析为 JSON(${step} 阶段),不再兜底 pass`);
    this.name = "EvalParseError";
  }
}

/** 视觉路由解析:返回 null 表示当前配置无任何可用视觉模型 */
export function resolveVision(config: Config, evalProviderKey: string): { provider: LlmProvider; model: string } | null {
  for (const key of [evalProviderKey, "kimi", "glm", "deepseek"]) {
    const model = getVisionModel(config, key);
    if (!model) continue;
    try {
      return { provider: getProvider(config, key), model };
    } catch {
      // 未配 apiKey 等 → 试下一家
    }
  }
  return null;
}

/** 评审目标解析:modelSpec 形如 "provider:model"(降级链换模型用),缺省走 eval 档配置 */
export function resolveEvalTarget(config: Config, modelSpec?: string): { provider: LlmProvider; model: string } {
  if (modelSpec) {
    const idx = modelSpec.indexOf(":");
    if (idx > 0) {
      return { provider: getProvider(config, modelSpec.slice(0, idx)), model: modelSpec.slice(idx + 1) };
    }
  }
  return resolveModelFor(config, "eval");
}

const VISION_REQUIRED_STEPS = new Set(["assets", "assembly"]);

export interface ApiEvaluatorOpts {
  workId: string;
  step: string;
  evalPrompt: string;
  config: Config;
  workDir: string;
  session: WsSession;
  bridge: WsBridge;
  /** 降级链"换模型"段(2026-08-28 批次1.3):形如 "provider:model",覆盖 eval 档配置 */
  modelSpec?: string;
}

export async function runApiEvaluator(opts: ApiEvaluatorOpts): Promise<EvalResult> {
  const { config, step } = opts;
  const { provider, model } = resolveEvalTarget(config, opts.modelSpec);
  // L2 补修(2026-09):评审与创作跨家族告警——self-preference 偏差。
  // 强制改模型是配置层决策（设置页改 llm.models.eval），代码层只做可观测告警。
  try {
    const createProvider = resolveModelFor(config, "plan").provider.name;
    if (provider.name === createProvider) {
      console.warn(`[evaluator] 评审 provider(${provider.name})与创作同家族,存在 self-preference 偏差——建议在设置页将 llm.models.eval 改为跨家族模型(kimi/glm)`);
    }
  } catch { /* 创作 provider 解析失败不阻断评审 */ }
  // Q3(方案定稿):编译 criteria 的硬性维度 min_ai(否定聚合数据源)——读评审标准文件
  let criteria: { hardDims?: string[]; minAi?: Record<string, number> } | undefined;
  try {
    const { readCriteriaPathForStep } = await import("../server/step-contract.js");
    const { existsSync, readFileSync } = await import("node:fs");
    const w = await import("../work-store.js").then((m) => m.getWork(opts.workId)).catch(() => undefined);
    const criteriaPath = readCriteriaPathForStep(step, w?.type);
    if (existsSync(criteriaPath)) {
      criteria = compileCriteriaMinAi(readFileSync(criteriaPath, "utf-8"));
    }
  } catch { /* criteria 编译失败不阻断评审 */ }
  const vision = resolveVision(config, provider.name);
  if (VISION_REQUIRED_STEPS.has(step) && !vision) {
    throw new Error(
      `「${step}」阶段评审需要看图,但当前未配置任何视觉模型——请在设置页「大模型直连」为 Kimi 或 GLM 配置 apiKey/visionModel`,
    );
  }

  const sink = createLoopEventSink(opts.session, opts.bridge, { source: "evaluator" });
  // 评审进行中标记:runner 健康检查据此判定会话存活(isWorkActive),防评审窗口被误判死亡
  opts.session.evalLoopRunning = true;
  opts.session.evalStartedAt = Date.now();
  const loop = new AgentLoop({
    provider,
    model,
    systemPrompt: "你是严格的内容质量评审专家。用只读工具(Read/Glob/Grep/Bash)检查用户消息指定的阶段产出,最终只输出评审结论 JSON。",
    tools: buildEvaluatorTools({ bashBlocklist: config.llm?.guard?.bashBlocklist }),
    visionProvider: vision?.provider,
    visionModel: vision?.model,
    workDir: opts.workDir,
    onLoopEvent: (ev) => {
      opts.session.lastActivityAt = Date.now();
      if (ev.type === "vision_route") {
        console.log(`[evaluator] ${opts.workId}/${step}: ImageBlock 回合路由 → ${ev.text}`);
      }
      sink(ev);
    },
    guard: {
      maxStepsPerTurn: config.llm?.guard?.maxStepsPerTurn,
      maxTurnMinutes: config.llm?.guard?.maxTurnMinutes,
    },
    usageContext: { workId: opts.workId, stage: `eval:${step}` },
  });

  // 硬超时:到期 abortTurn(abort 信号一路传到 chatStream/Bash,清理链现成);
  // runTurn 随后以 throw 或 stopReason="aborted" 返回,两种形态都由 timedOut 标志统一转 EvalTimeoutError
  // 2026-09-01 批次12b(系统审查实证):assembly/assets 评审要看几十条素材+抽帧,
  // 15min 常态不够(dde/a4d 各触发一次超时白烧 25min)——按阶段放宽,其余阶段不变
  const stepTimeoutFloor = ["assembly", "assets"].includes(step) ? 25 : 0;
  const evalTimeoutMs = Math.max(config.llm?.guard?.evalTimeoutMinutes ?? 15, stepTimeoutFloor) * 60_000;
  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    console.warn(`[evaluator] ${opts.workId}/${step}: 评审硬超时(${Math.round(evalTimeoutMs / 60000)}min),中止评审回合`);
    loop.abortTurn();
  }, evalTimeoutMs);

  try {
    const { resultText } = await loop.runTurn(opts.evalPrompt);
    if (timedOut) throw new EvalTimeoutError(step, evalTimeoutMs);
    let result = parseEvalResultText(resultText, step, criteria) as EvalResult & { __parseFailed?: boolean };
    if (result.__parseFailed) {
      // 解析失败不再是静默 pass:先让评审重出一轮(大概率是话痨没按格式输出)
      console.warn(`[evaluator] ${opts.workId}/${step}: 评审输出无法解析为 JSON,要求重出一轮`);
      const retry = await loop.runTurn(
        "你的上一条输出无法解析为评审结论 JSON。请只输出一个 ```json 代码块" +
        "(字段: verdict \"pass\"|\"fail\", scores, issues[{severity,description}], suggestions[])," +
        "不要输出任何其他文字。",
      );
      if (timedOut) throw new EvalTimeoutError(step, evalTimeoutMs);
      result = parseEvalResultText(retry.resultText, step, criteria) as EvalResult & { __parseFailed?: boolean };
      if (result.__parseFailed) {
        // 2026-08-28 批次1.5:重出仍失败 → 显式错误进 eval_error 链,堵死兜底 pass 放水通道
        // 2026-08-31 实测(dde/assembly):两轮解析失败无任何现场可复盘——落盘原文供诊断
        try {
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          writeFileSync(
            join(opts.workDir, `eval-parsefail-${step}-${Date.now()}.txt`),
            `--- 首轮输出(前4000字) ---\n${resultText.slice(0, 4000)}\n\n--- 重出轮输出(前4000字) ---\n${retry.resultText.slice(0, 4000)}`,
            "utf-8",
          );
        } catch { /* 落盘失败不阻断错误链 */ }
        throw new EvalParseError(step);
      }
    }
    return result;
  } catch (err) {
    if (timedOut && !(err instanceof EvalTimeoutError)) throw new EvalTimeoutError(step, evalTimeoutMs);
    throw err;
  } finally {
    clearTimeout(hardTimer);
    opts.session.evalLoopRunning = false;
    opts.session.evalStartedAt = undefined;
  }
}
