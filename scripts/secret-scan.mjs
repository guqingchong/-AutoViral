#!/usr/bin/env node
/**
 * pre-commit 密钥扫描(2026-09-18 泄漏事故防线,零依赖)。
 *
 * 背景:2026-08-17 一个 Claude 会话把真实 DeepSeek key 硬编码进
 * tests/server/api-config-llm.test.ts 并推送到公开 GitHub 仓库,泄漏 32 天,
 * 被第三方滥用 v4-Pro 烧光账户余额。本脚本在提交前拦截 staged 新增内容中的
 * 疑似真实凭据——测试/文档只允许合成假凭据(sk-test-fake-… 等)。
 *
 * 豁免:行内含 fake/test/example/占位/your- 等标记;或在行尾加 `secret-scan:ignore`。
 * 手动跳过(仅限确认误报):SECRET_SCAN_SKIP=1 git commit …
 */
import { execSync } from "node:child_process";

const PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{20,}/, name: "OpenAI 风格 API key (sk-…)" },
  { re: /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{16,}\b/, name: "GLM 风格 API key (hex.hex)" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, name: "PEM 私钥块" },
];

// 明确的非真实凭据标记
const EXEMPTION = /fake|test|example|占位|your[-_]|xxx|\*\*\*|REMOVED|secret-scan:ignore/i;

let diff = "";
try {
  diff = execSync("git diff --cached -U0 --no-color", { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
} catch {
  process.exit(0); // 非 git 环境不拦截
}

if (process.env.SECRET_SCAN_SKIP === "1") {
  console.warn("[secret-scan] SECRET_SCAN_SKIP=1,跳过扫描(仅限确认误报时使用)");
  process.exit(0);
}

let file = "";
let lineNo = 0;
const findings = [];
for (const line of diff.split("\n")) {
  const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
  if (fileMatch) { file = fileMatch[1]; continue; }
  const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  if (hunkMatch) { lineNo = parseInt(hunkMatch[1], 10); continue; }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    lineNo++;
    const content = line.slice(1);
    if (EXEMPTION.test(content)) continue;
    for (const p of PATTERNS) {
      if (p.re.test(content)) {
        findings.push(`${file}:${lineNo} 疑似 ${p.name}`);
        break;
      }
    }
  }
}

if (findings.length) {
  console.error("[secret-scan] 拦截:staged 内容含疑似真实凭据(2026-09-18 泄漏事故防线):");
  for (const f of findings.slice(0, 10)) console.error("  " + f);
  console.error("\n若是测试/文档,请改用合成假值(如 sk-test-fake-…);确认误报在行尾加 `secret-scan:ignore`。");
  process.exit(1);
}
process.exit(0);
