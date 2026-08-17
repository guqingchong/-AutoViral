/** Write 工具：整文件写入（自动 mkdir -p） */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolExecutor } from "./index.js";
import { assertPath } from "./common.js";

export const writeExecutor: ToolExecutor = {
  def: {
    name: "Write",
    description: "将内容写入文件（覆盖已存在文件，自动创建父目录）。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["file_path", "content"],
    },
  },
  async execute(input, ctx): Promise<string> {
    const filePath = String(input.file_path ?? "");
    const content = String(input.content ?? "");
    if (!filePath) throw new Error("Write: file_path 必填");
    const abs = assertPath(filePath, ctx.workDir);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
    return `已写入 ${filePath}（${content.length} 字符）`;
  },
};
