/**
 * 模型显示名映射（2026-09-10）。
 *
 * 约定：下拉项的 **value 永远是可发送的真实 model id**，label 缺省原样显示——
 * 所以 DeepSeek 目录自动更新（src/llm/deepseek-models.ts）拉来的新模型
 * 无需登记也能自动出现在设置页。
 *
 * 为什么需要本表：2026-09-10 官方发布的模型名为「DeepSeek V4.1 Flash」，
 * 但 API 的真实 model id 是 `deepseek-flash`——实测 GET /models 与 400 报错
 * 均确认官方**不存在** "deepseek-v4.1-flash" 这个 id（把它当真 id 发送会
 * invalid_request_error）。因此界面显示友好名、请求发送真实 id，两不耽误。
 */
export const MODEL_LABELS: Record<string, string> = {
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash（旧别名）",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4 Flash Vision（实验，已下线）",
};

export function modelLabel(modelId: string): string {
  return MODEL_LABELS[modelId] ?? modelId;
}
