/**
 * Tone profile prompt injection utility.
 *
 * Converts an account's `tone_profile` JSON blob into a structured prompt
 * prefix/suffix that instructs Claude to write in a specific voice/style.
 * Used by content-generator, trend-research, and work chat sessions.
 */

/**
 * Standard tone profile keys and their Chinese descriptions.
 * Unknown keys are included verbatim.
 */
const KEY_LABELS: Record<string, string> = {
  voice: "内容风格/语调",
  audience: "目标受众",
  style: "写作风格",
  tone: "语气",
  wordCount: "篇幅要求",
  contentType: "内容类型偏好",
  avoidTopics: "需避免的话题",
  brandVoice: "品牌声音定位",
  hookStyle: "爆款钩子风格",
  format: "输出格式要求",
  personality: "人设/人格",
  values: "核心价值观",
  niche: "垂类/细分领域",
  competitorDifferentiator: "与竞品的差异化",
};

/**
 * Build a Chinese-language prompt injection string from an account's
 * tone_profile JSON object. Returns an empty string when the profile
 * is empty or null.
 *
 * Output example:
 * ```
 * ## 账号风格要求（请严格遵循）
 * - 内容风格/语调：权威专业
 * - 目标受众：25-35岁职场人
 * - 篇幅要求：800-1200字
 * ```
 */
export function buildTonePrompt(toneProfile: Record<string, unknown> | null | undefined): string {
  if (!toneProfile) return "";

  const entries = Object.entries(toneProfile);
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("## 账号风格要求（请严格遵循）");
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (value === "" || value === false) continue;
    const label = KEY_LABELS[key] ?? key;
    if (typeof value === "string") {
      lines.push(`- ${label}：${value}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`- ${label}：${String(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`- ${label}：${value.join("、")}`);
    } else if (typeof value === "object") {
      // Nested object — flatten to key: value pairs
      const nested = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("，");
      if (nested) lines.push(`- ${label}：${nested}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") + "\n" : "";
}
