/**
 * 视觉 JSON 生成（2026-08-18 P3-T1）。
 *
 * 替代 CLI 时代的 runVisionCli（spawn claude + Read 本地图片）：
 * 图片直接读盘转 base64 作为 ImageBlock 进请求，一次 chatStream 出 JSON。
 * 视觉模型解析顺序：kimi visionModel → glm visionModel（与 evaluator.resolveVision 同序）。
 */

import { readFile } from "node:fs/promises";
import type { Config } from "../config.js";
import { getProvider, getVisionModel } from "./registry.js";
import type { ContentBlock, ImageBlock, TextBlock } from "./types.js";
import { extractJsonFromText, JSON_OUTPUT_DISCIPLINE } from "./json-extract.js";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export async function chatVisionJson<T>(
  config: Config,
  imagePaths: string[],
  prompt: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  // 视觉 provider 解析:kimi 优先(实测 glm-4v 不支持 tools 且视觉细节弱),glm 兜底
  let provider, model: string | undefined;
  for (const key of ["kimi", "glm"]) {
    model = getVisionModel(config, key);
    if (!model) continue;
    try {
      provider = getProvider(config, key);
      break;
    } catch { /* 未配 apiKey → 试下一家 */ }
  }
  if (!provider || !model) {
    throw new Error("视觉分析需要看图,但未配置任何视觉模型——请在设置页「大模型直连」为 Kimi 或 GLM 配置 apiKey/visionModel");
  }

  const images: ImageBlock[] = [];
  for (const p of imagePaths) {
    const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
    const buf = await readFile(p);
    images.push({ type: "image", mediaType: MEDIA_TYPES[ext] ?? "image/png", base64: buf.toString("base64") });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 480_000);
  // 直连记账(2026-08-19 P1):视觉调用此前全漏账
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const onEvent = (ev: unknown) => {
    const e = ev as { type?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    if (e?.type === "usage") {
      acc.inputTokens += e.inputTokens ?? 0;
      acc.outputTokens += e.outputTokens ?? 0;
      acc.cacheReadTokens += e.cacheReadTokens ?? 0;
    }
  };
  try {
    const content: ContentBlock[] = [
      { type: "text", text: prompt + JSON_OUTPUT_DISCIPLINE },
      ...images,
    ];
    const { assistant } = await provider.chatStream(
      { model, system: "", messages: [{ role: "user", content }], tools: [], maxTokens: 8192, allowImages: true, signal: controller.signal },
      onEvent,
    );
    const text = assistant.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = extractJsonFromText(text);
    if (parsed === null) {
      throw new Error(`chatVisionJson 无法从响应提取 JSON: ${text.slice(0, 200)}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
    if (acc.inputTokens > 0 || acc.outputTokens > 0) {
      const { recordUsageAsync } = await import("../services/llm-usage.js");
      recordUsageAsync({ stage: "vision", provider: provider.name, model: model!, ...acc });
    }
  }
}
