/**
 * JSON 提取工具（2026-08-18 P3-T1 从 services/llm-json.ts 迁入 llm/ 层，
 * 破除 openai-compat → services/llm-json → llm/registry → openai-compat 循环引用）。
 */

/**
 * Try to extract a JSON object from arbitrary text.
 * Strips markdown fences, finds first { and last }, and parses.
 * Returns null if no valid JSON found.
 */
export function extractJsonFromText(text: string): unknown | null {
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
}

/** JSON 生成场景的输出纪律后缀（CLI 时代 runJsonPrompt 的硬约束，直连架构同样适用：
 *  模型爱裹 markdown 围栏/解释文字，提取容错有上限） */
export const JSON_OUTPUT_DISCIPLINE =
  "\n\n## 输出纪律（必须严格遵守）\n" +
  "- 直接把 JSON 作为你的回复文本输出，不要调用任何工具。\n" +
  "- 禁止创建、写入或保存任何文件；禁止执行命令。\n" +
  "- 不要使用 markdown 代码围栏，不要输出 JSON 以外的任何解释文字。\n";
