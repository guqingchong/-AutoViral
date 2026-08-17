/**
 * 指数退避重试（2026-08-16 架构改造）。
 * 语义照搬 llm-json.ts:47-68 的已验证模式：
 * - 默认 3 次尝试，退避 [5s, 15s, 30s]
 * - HTTP 429/5xx 与网络错误可重试；4xx 打 noRetry 直接抛
 * - 流式已开始输出后不再整体重试（由调用方决定续跑策略，避免重复输出混入）
 */

export interface RetryOptions {
  maxAttempts?: number;
  backoffs?: number[];
}

/** 标记不可重试的错误（4xx 鉴权/参数类） */
export function noRetry(err: Error): Error {
  (err as Error & { noRetry?: boolean }).noRetry = true;
  return err;
}

export function isNoRetry(err: unknown): boolean {
  return Boolean((err as Error & { noRetry?: boolean })?.noRetry);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffs = opts.backoffs ?? [5000, 15000, 30000];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (isNoRetry(err) || attempt >= maxAttempts) throw err;
      const wait = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
