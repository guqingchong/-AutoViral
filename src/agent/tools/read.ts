/** Read 工具：文本截断读取；图片返回 ImageBlock（base64）——视觉能力入口 */

import { readFile, stat } from "node:fs/promises";
import type { ContentBlock } from "../../llm/types.js";
import type { ToolExecutor } from "./index.js";
import { assertPath, truncateMiddle } from "./common.js";

const IMAGE_EXTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const readExecutor: ToolExecutor = {
  def: {
    name: "Read",
    description: "读取文件内容。文本文件返回内容（超长截断）；图片文件（png/jpg/jpeg/webp/gif）返回图片内容供视觉模型查看。",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "文件绝对路径，或相对作品目录的路径" },
      },
      required: ["file_path"],
    },
  },
  async execute(input, ctx): Promise<string | ContentBlock[]> {
    const filePath = String(input.file_path ?? input.path ?? "");
    if (!filePath) throw new Error("Read: file_path 必填");
    const abs = assertPath(filePath, ctx.workDir);
    const ext = filePath.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (IMAGE_EXTS[ext]) {
      const st = await stat(abs);
      if (st.size > 10 * 1024 * 1024) throw new Error(`图片过大（${Math.round(st.size / 1024 / 1024)}MB），请先压缩到 10MB 内`);
      const buf = await readFile(abs);
      return [
        { type: "image", mediaType: IMAGE_EXTS[ext], base64: buf.toString("base64") },
      ];
    }
    const content = await readFile(abs, "utf-8");
    return truncateMiddle(content, 20_000, 8_000, 10_000);
  },
};
