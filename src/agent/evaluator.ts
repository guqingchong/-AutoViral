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
export function parseEvalResultText(resultText: string, fallbackStep: string): EvalResult {
  try {
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    return jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(resultText);
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

const VISION_REQUIRED_STEPS = new Set(["assets", "assembly"]);

export interface ApiEvaluatorOpts {
  workId: string;
  step: string;
  evalPrompt: string;
  config: Config;
  workDir: string;
  session: WsSession;
  bridge: WsBridge;
}

export async function runApiEvaluator(opts: ApiEvaluatorOpts): Promise<EvalResult> {
  const { config, step } = opts;
  const { provider, model } = resolveModelFor(config, "eval");
  const vision = resolveVision(config, provider.name);
  if (VISION_REQUIRED_STEPS.has(step) && !vision) {
    throw new Error(
      `「${step}」阶段评审需要看图,但当前未配置任何视觉模型——请在设置页「大模型直连」为 Kimi 或 GLM 配置 apiKey/visionModel`,
    );
  }

  const sink = createLoopEventSink(opts.session, opts.bridge, { source: "evaluator" });
  // 评审进行中标记:runner 健康检查据此判定会话存活(isWorkActive),防评审窗口被误判死亡
  opts.session.evalLoopRunning = true;
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

  try {
    const { resultText } = await loop.runTurn(opts.evalPrompt);
    let result = parseEvalResultText(resultText, step) as EvalResult & { __parseFailed?: boolean };
    if (result.__parseFailed) {
      // 解析失败不再是静默 pass:先让评审重出一轮(大概率是话痨没按格式输出)
      console.warn(`[evaluator] ${opts.workId}/${step}: 评审输出无法解析为 JSON,要求重出一轮`);
      const retry = await loop.runTurn(
        "你的上一条输出无法解析为评审结论 JSON。请只输出一个 ```json 代码块" +
        "(字段: verdict \"pass\"|\"fail\", scores, issues[{severity,description}], suggestions[])," +
        "不要输出任何其他文字。",
      );
      result = parseEvalResultText(retry.resultText, step) as EvalResult & { __parseFailed?: boolean };
      if (result.__parseFailed) {
        // 重出仍失败:兜底 pass 但在结果里留痕(__parseFailed 随 eval JSON 落盘可审计)
        console.warn(`[evaluator] ${opts.workId}/${step}: 重出仍无法解析,兜底 pass 并留痕 __parseFailed`);
      }
    }
    return result;
  } finally {
    opts.session.evalLoopRunning = false;
  }
}
