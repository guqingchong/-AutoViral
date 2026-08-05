// 时间戳解析工具 — 统一处理库内两种并存的时间格式：
// 1. JS new Date().toISOString()："2026-08-05T10:00:00.000Z"（UTC，带 T/Z）
// 2. SQLite datetime('now')："2026-08-05 10:00:00"（UTC，空格分隔，无时区后缀）
// 无时区后缀的值一律按 UTC 解释，避免被 Date.parse 当成本地时间。

/**
 * 解析时间戳为毫秒数；无法解析返回 null。
 * 兼容 ISO 8601（带 T、带/不带 Z、带偏移）与 datetime('now') 空格格式。
 */
export function parseTsMs(value: string | null | undefined): number | null {
  if (!value) return null;
  let v = value.trim();
  if (!v) return null;
  // 空格分隔的日期时间 → ISO 形式
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) v = v.replace(" ", "T");
  // 无 timezone 后缀（Z 或 ±hh:mm）→ 按 UTC 处理
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += "Z";
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 归一化为 ISO 8601 UTC 字符串（带 Z，如 "2026-08-05T10:00:00.000Z"）；
 * 无法解析返回 null。用于下发前端 —— Safari 的 Date.parse 不认空格分隔格式，
 * Chrome 会把它当本地时间，统一带 Z 后两端行为一致。
 */
export function toIsoUtc(value: string | null | undefined): string | null {
  const ms = parseTsMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * 从候选时间戳中取最新的一个，返回其原始字符串（不改动格式）；
 * 全部为空或无法解析时返回 null。
 */
export function latestTimestamp(candidates: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const c of candidates) {
    const ms = parseTsMs(c);
    if (ms !== null && ms > bestMs) {
      bestMs = ms;
      best = c as string;
    }
  }
  return best;
}
