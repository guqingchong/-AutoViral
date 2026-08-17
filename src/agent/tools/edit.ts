/** Edit 工具：精确字符串替换（old_string 必须唯一匹配） */

import { readFile, writeFile } from "node:fs/promises";
import type { ToolExecutor } from "./index.js";
import { assertPath } from "./common.js";

export const editExecutor: ToolExecutor = {
  def: {
    name: "Edit",
    description: "对文件做精确字符串替换。old_string 必须在文件中唯一匹配（0 处或多处都报错）；replace_all=true 时替换全部。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string", description: "被替换的原文（需唯一匹配）" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "替换全部匹配（默认 false）" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  async execute(input, ctx): Promise<string> {
    const filePath = String(input.file_path ?? "");
    const oldStr = String(input.old_string ?? "");
    const newStr = String(input.new_string ?? "");
    const replaceAll = input.replace_all === true;
    if (!filePath || !oldStr) throw new Error("Edit: file_path/old_string 必填");
    if (oldStr === newStr) throw new Error("Edit: new_string 与 old_string 相同");
    const abs = assertPath(filePath, ctx.workDir);
    const content = await readFile(abs, "utf-8");
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) throw new Error(`Edit: 未找到匹配文本: ${oldStr.slice(0, 80)}...`);
    if (occurrences > 1 && !replaceAll) throw new Error(`Edit: 找到 ${occurrences} 处匹配，需唯一或 replace_all=true`);
    const next = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await writeFile(abs, next, "utf-8");
    return `已编辑 ${filePath}（替换 ${replaceAll ? occurrences : 1} 处）`;
  },
};
