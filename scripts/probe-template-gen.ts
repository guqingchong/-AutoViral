/**
 * 探针:实测 deepseek-v4-flash 生成 3 个模板的真实耗时(2026-08-19 调试)
 * 背景:模板生成两次失败 "This operation was aborted",怀疑 300s 超时太短。
 * 运行: npx tsx scripts/probe-template-gen.ts
 */
import { generateTemplates } from "../src/services/template-generator.js";

const t0 = Date.now();
try {
  const result = await generateTemplates({ count: 3 });
  const ms = Date.now() - t0;
  console.log(`[probe] SUCCESS in ${(ms / 1000).toFixed(0)}s, templates: ${result.length}`);
  for (const t of result) console.log(`  - ${t.id} ${t.name}`);
} catch (err) {
  const ms = Date.now() - t0;
  console.log(`[probe] FAILED in ${(ms / 1000).toFixed(0)}s:`, err instanceof Error ? err.message : err);
}
process.exit(0);
