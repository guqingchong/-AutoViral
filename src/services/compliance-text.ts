import { listBannedWords } from "../db/banned-words-repo.js";
import type { ComplianceResult } from "../db/types.js";

export type { ComplianceResult };

export interface ComplianceViolation {
  platform: string;
  word: string;
  severity: "low" | "medium" | "high";
  context: string;
}

export interface ScanOptions {
  text: string;
  platform: string;
}

export function scanBannedWords(options: ScanOptions): ComplianceResult {
  if (!options.text) return { passed: true, violations: [] };

  const words = listBannedWords(options.platform);
  const violations: ComplianceViolation[] = [];
  const seen = new Set<string>();

  for (const entry of words) {
    if (seen.has(entry.word)) continue;
    seen.add(entry.word);

    if (options.text.includes(entry.word)) {
      const index = options.text.indexOf(entry.word);
      const start = Math.max(0, index - 8);
      const end = Math.min(options.text.length, index + entry.word.length + 8);
      violations.push({
        platform: entry.platform,
        word: entry.word,
        severity: entry.severity,
        context: options.text.slice(start, end),
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
