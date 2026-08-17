/**
 * LLM 直连三家真实冒烟（2026-08-16 架构改造 Phase 0 验收项）。
 * 用法：node --experimental-strip-types scripts/llm-smoke.ts [providerKey...]（缺省跑 llm.providers 里已配 apiKey 的全部）
 *
 * 对每家跑三项：
 *  1. 文本流式（打印 stopReason/usage/缓存命中）
 *  2. 单工具回合（喂假工具 get_weather，断言模型产出 tool_use）
 *  3. vision 看图（用 visionModel 读一张程序生成的 png）
 * 结果写 docs/desigen/smoke-results.md（追加）。
 */

import { appendFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { getProvider, getVisionModel } from "../src/llm/registry.js";
import { PROVIDER_PRESETS } from "../src/llm/provider-keys.js";
import type { StreamEvent } from "../src/llm/types.js";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

/** 最小合法 PNG（1x1 红点），base64 内联避免依赖外部文件 */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 各 provider 的冒烟用文本模型；GLM 按用户约束只做视觉，不跑文本/工具（2026-08-16 用户指定） */
const TEXT_MODEL: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  kimi: "kimi-for-coding",   // Coding Plan 端点模型 ID（api.kimi.com/coding）
};
const VISION_ONLY = new Set(["glm"]);

async function smokeOne(key: string): Promise<string[]> {
  const config = await loadConfig();
  const lines: string[] = [`\n## ${key}（${new Date().toISOString()}）\n`];
  let provider;
  try {
    provider = getProvider(config, key);
  } catch (err) {
    lines.push(`- ⏭️ 跳过：${(err as Error).message}`);
    return lines;
  }

  // 1. 文本流式（vision-only 的 provider 跳过）
  const textModel = TEXT_MODEL[key];
  if (VISION_ONLY.has(key) || !textModel) {
    lines.push(`- ⏭️ 文本流式/工具回合：跳过（${key} 按约束仅用于视觉识别）`);
  } else
  try {
    const events: StreamEvent[] = [];
    const t0 = Date.now();
    const r = await provider.chatStream(
      {
        model: textModel,
        system: "你是测试助手。",
        messages: [{ role: "user", content: [{ type: "text", text: "用一句话回答：1+1=?" }] }],
        tools: [],
        maxTokens: 100,
      },
      (e) => events.push(e),
    );
    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }> | undefined;
    const text = r.assistant.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    lines.push(
      `- ✅ 文本流式(${textModel})：${r.stopReason}，${Date.now() - t0}ms，输出「${text.slice(0, 50)}」` +
      `，usage in=${usage?.inputTokens}/out=${usage?.outputTokens}/cacheHit=${usage?.cacheReadTokens ?? "n/a"}`,
    );
  } catch (err) {
    lines.push(`- ❌ 文本流式(${textModel})：${(err as Error).message.slice(0, 200)}`);
  }

  // 2. 单工具回合
  if (!VISION_ONLY.has(key) && textModel)
  try {
    const events: StreamEvent[] = [];
    const r = await provider.chatStream(
      {
        model: textModel,
        system: "你可以调用工具。",
        messages: [{ role: "user", content: [{ type: "text", text: "北京天气怎么样？调用工具查询。" }] }],
        tools: [{
          name: "get_weather",
          description: "查询城市天气",
          input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        }],
        maxTokens: 300,
      },
      (e) => events.push(e),
    );
    const toolUses = r.assistant.content.filter((b) => b.type === "tool_use");
    const first = toolUses[0] as { name: string; input: Record<string, unknown> } | undefined;
    lines.push(
      toolUses.length
        ? `- ✅ 工具回合：${first!.name}(${JSON.stringify(first!.input)})`
        : `- ❌ 工具回合：模型未产出 tool_use（stopReason=${r.stopReason}）`,
    );
  } catch (err) {
    lines.push(`- ❌ 工具回合：${(err as Error).message.slice(0, 200)}`);
  }

  // 3. vision 看图
  const visionModel = getVisionModel(config, key);
  if (!visionModel) {
    lines.push(`- ⏭️ vision：未配置 visionModel`);
  } else {
    try {
      const r = await provider.chatStream(
        {
          model: visionModel,
          system: "描述图片内容。",
          messages: [{ role: "user", content: [
            { type: "text", text: "这张图里有什么？" },
            { type: "image", mediaType: "image/png", base64: TINY_PNG_B64 },
          ] }],
          tools: [],
          maxTokens: 200,
        },
        () => {},
      );
      const text = r.assistant.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      lines.push(`- ✅ vision(${visionModel})：「${text.slice(0, 60)}」`);
    } catch (err) {
      lines.push(`- ❌ vision(${visionModel})：${(err as Error).message.slice(0, 200)}`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const argKeys = process.argv.slice(2);
  const keys = argKeys.length
    ? argKeys
    : Object.keys(PROVIDER_PRESETS).filter((k) => config.llm?.providers?.[k]?.apiKey);
  if (!keys.length) {
    console.log("未找到已配置 apiKey 的 provider。请先在 ~/.autoviral/config.yaml 的 llm.providers 配置，或设置页「大模型直连」填写。");
    process.exit(1);
  }
  const out: string[] = [];
  for (const k of keys) {
    console.log(`[smoke] ${k} ...`);
    out.push(...await smokeOne(k));
  }
  const reportPath = join(ROOT, "docs/desigen/smoke-results.md");
  await mkdir(join(ROOT, "docs/desigen"), { recursive: true });
  try {
    await appendFile(reportPath, out.join("\n") + "\n", "utf-8");
  } catch {
    await writeFile(reportPath, `# LLM 直连冒烟结果\n${out.join("\n")}\n`, "utf-8");
  }
  console.log(out.join("\n"));
  console.log(`\n结果已追加到 ${reportPath}`);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
