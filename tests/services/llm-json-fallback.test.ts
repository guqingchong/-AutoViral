/**
 * llm-json fallbackStage 单测(2026-09-02 kimi 504 事故)。
 *
 * 事故:整片/镜头模板生成(plan=kimi)单次响应大,kimi 网关 504,withRetry 同
 * provider 原地重试无效,任务直接失败。修复:外部服务故障(5xx/网络)整体回退
 * 到 fallbackStage(assets=deepseek);解析失败/4xx 不回退(换模型无意义)。
 */
import { describe, it, expect } from "vitest";
import { isExternalServiceError } from "../../src/services/llm-json.js";

describe("isExternalServiceError(外部服务故障判定)", () => {
  it("5xx/网络/超时 → 可回退", () => {
    expect(isExternalServiceError(new Error("LLM API 504: <html>Gateway Time-out</html>"))).toBe(true);
    expect(isExternalServiceError(new Error("LLM API 500 Internal Server Error"))).toBe(true);
    expect(isExternalServiceError(new Error("fetch failed"))).toBe(true);
    expect(isExternalServiceError(new Error("connect ECONNREFUSED 127.0.0.1"))).toBe(true);
    expect(isExternalServiceError(new Error("This operation was aborted"))).toBe(true);
    expect(isExternalServiceError(new Error("request timed out after 600s"))).toBe(true);
    // 429 持续限流(withRetry 退避耗尽后)也是 provider 级故障,回退有意义
    expect(isExternalServiceError(new Error("LLM API 429: rate limited"))).toBe(true);
  });

  it("4xx 鉴权/解析失败 → 不回退(换模型无意义)", () => {
    expect(isExternalServiceError(new Error("LLM API 401: invalid api key"))).toBe(false);
    expect(isExternalServiceError(new Error("LLM API 400: bad request"))).toBe(false);
    expect(isExternalServiceError(new Error("无法从响应提取 JSON"))).toBe(false);
    expect(isExternalServiceError(new Error("brief 会话不存在"))).toBe(false);
  });
});
