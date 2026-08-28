/**
 * AskUserQuestion 工具(2026-08-28 批次2.6 激活)。
 *
 * 此前是死代码:loop.ts 的配对回填、Studio 前端的选项卡渲染、测试全都在,
 * 唯独这里从未注册——agent "主动问用户"的通道实际不存在。
 *
 * 执行语义:loop.ts 在 tool_use 阶段拦截(置 pendingAskToolUseId、回合以
 * awaiting_user 结束、用户下一条输入作为 tool_result 回填),execute 永远不会被调用。
 */

import type { ToolExecutor } from "./index.js";

export const askUserQuestionExecutor: ToolExecutor = {
  def: {
    name: "AskUserQuestion",
    description:
      "向用户提问并等待回答后继续。autoMode(无人值守)下仅限白名单问题:" +
      "①素材二选一无法研判 ②降质确认 ③预算超档;其余一律自行拍板,禁止滥用。" +
      "调用后回合暂停,用户回答会作为本工具的结果返回。",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "完整问题" },
              header: { type: "string", description: "短标签(≤12字)" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean" },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
  async execute() {
    return "错误:AskUserQuestion 由回合层(awaiting_user 配对回填)处理,不应执行到这里";
  },
};
