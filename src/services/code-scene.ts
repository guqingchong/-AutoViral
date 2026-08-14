/**
 * 代码渲染场景素材(2026-08-14 代码渲染素材层集成)。
 *
 * agent 为结构图/流程图/逻辑链条镜头调用,经子项目 worker(Revideo)渲染
 * 程序化动画 mp4。本服务负责:参数校验(审美确定性)、串行队列、
 * spawn 渲染、质量门禁、资产登记。
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { probeMedia } from "../video/ffmpeg.js";

const WORKER_DIR = join(process.cwd(), "packages", "code-scene");
const RENDER_TIMEOUT_MS = 180_000;
const VALID_THEMES = new Set(["finance_dark", "warm_gold", "ink_green", "minimal_light"]);

export interface CodeSceneInput {
  workId: string;
  filename: string;
  template?: { name: string; params: Record<string, unknown> };
  customScene?: string;
  duration?: number;
  size?: { w: number; h: number };
  theme?: string;
}

const TEMPLATE_LIMITS: Record<string, { items: string; min: number; max: number }> = {
  "structure-growth": { items: "branches", min: 2, max: 4 },
  "flow-steps": { items: "steps", min: 2, max: 5 },
  "logic-chain": { items: "chain", min: 2, max: 4 },
};

/** 纯校验:返回错误列表(空数组=合法) */
export function validateCodeSceneInput(input: CodeSceneInput): string[] {
  const errors: string[] = [];
  if (!input.workId) errors.push("workId 必填");
  if (!input.filename || !/^[\w-]+$/.test(input.filename)) errors.push("filename 必填且仅限字母数字连字符");

  const hasTemplate = !!input.template;
  const hasCustom = !!input.customScene;
  if (hasTemplate === hasCustom) {
    errors.push("template 与 customScene 必须二选一");
  } else if (hasTemplate) {
    const t = input.template!;
    const limit = TEMPLATE_LIMITS[t.name];
    if (!limit) {
      errors.push(`未知场景模板: ${t.name}(可选: ${Object.keys(TEMPLATE_LIMITS).join("/")})`);
    } else {
      const p = t.params ?? {};
      const title = p.title;
      if (typeof title !== "string" || !title.trim()) errors.push("params.title 必填");
      else if ([...title].length > 12) errors.push(`params.title ≤12 字(当前 ${[...title].length})`);
      if (t.name === "structure-growth" && (typeof p.center !== "string" || !p.center.trim())) {
        errors.push("params.center 必填");
      }
      const items = p[limit.items];
      if (!Array.isArray(items)) errors.push(`params.${limit.items} 必须是数组`);
      else if (items.length < limit.min || items.length > limit.max) {
        errors.push(`params.${limit.items} 数量须 ${limit.min}-${limit.max}(当前 ${items.length})`);
      }
    }
  }

  if (input.duration !== undefined && (input.duration < 1 || input.duration > 30)) {
    errors.push("duration 须在 1-30 秒之间");
  }
  if (input.theme !== undefined && !VALID_THEMES.has(input.theme)) {
    errors.push(`theme 非法: ${input.theme}(可选: ${[...VALID_THEMES].join("/")})`);
  }
  if (input.size && ((input.size.w ?? 0) < 256 || (input.size.h ?? 0) < 256)) {
    errors.push("size 宽高均须 ≥256");
  }
  return errors;
}
