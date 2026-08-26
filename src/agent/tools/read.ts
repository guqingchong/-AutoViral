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

/**
 * 魔数嗅探(2026-08-26):无扩展名文件按内容识别——素材库存在大量无扩展名的
 * 图片/视频(ct_redline_48148 等),纯按扩展名分流会把二进制当 UTF-8 文本读,
 * 向上下文灌入数万字符乱码(实测 3 个 JPEG ≈ 60KB mojibake)。
 */
function sniffMediaType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** 粗判二进制:前 8KB 含 NUL 字节即非文本 */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

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
    // 无扩展名/未知扩展:先嗅探魔数,图片照样走视觉通道;其余二进制拒绝当文本灌入上下文
    const buf = await readFile(abs);
    const sniffed = sniffMediaType(buf);
    if (sniffed) {
      if (buf.length > 10 * 1024 * 1024) throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB），请先压缩到 10MB 内`);
      return [{ type: "image", mediaType: sniffed, base64: buf.toString("base64") }];
    }
    if (looksBinary(buf)) {
      return `二进制文件（${Math.round(buf.length / 1024)}KB），无法用 Read 按文本查看。` +
        `若是图片请重命名加扩展名(.jpg/.png)后重试;若是视频/音频请用 ffprobe 检查。`;
    }
    const content = buf.toString("utf-8");
    return truncateMiddle(content, 20_000, 8_000, 10_000);
  },
};
