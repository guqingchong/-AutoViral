#!/usr/bin/env npx tsx
/**
 * HeyGem 数字人 端到端验收脚本（真实 AutoDL 实例）
 *
 * 前置条件（详见 docs/heygem-instance-setup.md）：
 *   1. 已按手册完成实例镜像改造（端口 6006 + Bearer Token）并固化私有镜像
 *   2. AutoViral 配置已填：heygem.baseUrl / heygem.apiToken / heygem.gpuHourlyRateYuan
 *   3. 已在 AutoDL 控制台手动开机实例，且 HeyGem API 已就绪
 *
 * 运行：npx tsx scripts/test-heygem-live.ts
 *
 * 测试素材（默认指向主仓库路径，如不一致请用环境变量覆盖并确认路径存在）：
 *   HEYGEM_TEST_VIDEO  形象源视频，默认 D:/Autoviral/data/test-assets/guqingchong-2.mp4
 *   HEYGEM_TEST_AUDIO  约 10 秒测试音频，默认 D:/Autoviral/data/test-assets/test-script.wav
 *
 * 注意：本脚本使用真实用户配置与数据库（~/.autoviral 或 AUTOVIRAL_DATA_DIR），
 *       会在库里留下一个测试形象和一个已完成任务，可在前端页面手动删除。
 *       脚本不会开关机实例——结束后如不再使用，请记得去 AutoDL 控制台手动关机。
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

const TEST_VIDEO = process.env.HEYGEM_TEST_VIDEO ?? "D:/Autoviral/data/test-assets/guqingchong-2.mp4";
const TEST_AUDIO = process.env.HEYGEM_TEST_AUDIO ?? "D:/Autoviral/data/test-assets/test-script.wav";

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 30 * 60_000; // 真实渲染最多等 30 分钟
const MIN_OUTPUT_BYTES = 100 * 1024; // 产物至少 100KB

function fail(message: string): never {
  console.error(`\n[FAIL] ${message}`);
  console.error("[提示] 如实例已开机且不再使用，请前往 AutoDL 控制台手动关机，避免持续计费");
  process.exit(1);
}

function step(message: string): void {
  console.log(`\n=== ${message} ===`);
}

async function main(): Promise<void> {
  step("第 0 步：加载配置与数据库");
  const { loadConfig } = await import("../src/config.js");
  const { migrate } = await import("../src/db/migrate.js");
  const config = await loadConfig();
  migrate();
  if (!config.heygem?.baseUrl) {
    fail("缺少 heygem.baseUrl 配置（实例 6006 端口公网地址），请先在设置页填写");
  }
  if (!config.heygem?.apiToken) {
    fail("缺少 heygem.apiToken 配置，请先在设置页填写");
  }
  if (!(config.heygem.gpuHourlyRateYuan > 0)) {
    fail("heygem.gpuHourlyRateYuan 未配置或为 0，无法断言 actual_cost > 0");
  }
  await stat(TEST_VIDEO).catch(() => fail(`形象源视频不存在：${TEST_VIDEO}（可用 HEYGEM_TEST_VIDEO 覆盖）`));
  await stat(TEST_AUDIO).catch(() => fail(`测试音频不存在：${TEST_AUDIO}（可用 HEYGEM_TEST_AUDIO 覆盖）`));
  console.log(`配置 OK：实例地址 ${config.heygem.baseUrl}，单价 ${config.heygem.gpuHourlyRateYuan} 元/小时`);
  console.log(`素材：video=${TEST_VIDEO}`);
  console.log(`素材：audio=${TEST_AUDIO}`);

  const instance = await import("../src/services/instance-service.js");
  const dh = await import("../src/services/digital-human.js");

  step("第 1 步：检查实例是否就绪（实例需已在 AutoDL 控制台手动开机）");
  const view = await instance.getInstanceView();
  console.log(`实例状态：state=${view.state}`);
  if (view.state !== "ready") {
    fail("请先到 AutoDL 控制台开机，并确认 heygem.baseUrl 配置正确");
  }
  console.log("[OK] 实例 ready");

  step("第 2 步：注册形象 + 提交合成任务");
  const videoBuf = await readFile(TEST_VIDEO);
  const avatar = await dh.createAvatarFromUpload("e2e验收形象", videoBuf, basename(TEST_VIDEO));
  console.log(`形象已注册：id=${avatar.id}，status=${avatar.status}`);
  if (avatar.status !== "ready") fail(`形象状态异常：${avatar.status}`);

  const job = await dh.submitJob({
    avatarId: avatar.id,
    audioUrl: TEST_AUDIO,
    estimatedCost: 0.05,
  });
  console.log(`任务已提交：jobId=${job.id}，providerJobId=${job.provider_job_id}`);

  step("第 3 步：轮询任务至完成（最多 30 分钟）");
  const done = await dh.pollJob(job.id, POLL_INTERVAL_MS, POLL_TIMEOUT_MS);
  if (!done) fail("轮询后任务记录丢失");
  console.log(`任务终态：status=${done.status}，progress=${done.progress}，actual_cost=${done.actual_cost}`);
  if (done.status !== "done") {
    fail(`任务未成功：status=${done.status}，error=${done.error ?? "无"}`);
  }
  if (!done.result_local_path) fail("任务完成但缺少 result_local_path");
  const out = await stat(done.result_local_path).catch(() => fail(`产物文件不存在：${done.result_local_path}`));
  if (out.size <= MIN_OUTPUT_BYTES) {
    fail(`产物过小：${out.size} 字节（要求 > ${MIN_OUTPUT_BYTES}），路径 ${done.result_local_path}`);
  }
  if (!(done.actual_cost > 0)) {
    fail(`actual_cost 应大于 0，实际为 ${done.actual_cost}`);
  }
  console.log(`[OK] 产物 ${done.result_local_path}（${(out.size / 1024).toFixed(1)} KB），成本 ${done.actual_cost} 元`);

  console.log("\n========================================");
  console.log("PASS: HeyGem 端到端验收全部通过");
  console.log(`  - 形象：${avatar.id}`);
  console.log(`  - 任务：${done.id}（产物 ${done.result_local_path}）`);
  console.log("  - 可在前端预览该任务产物，确认无误后手动删除测试数据");
  console.log("========================================");
  console.log("[提醒] 测试完成，如不再使用请记得前往 AutoDL 控制台关机，避免持续计费");

  const { closeDb } = await import("../src/db/connection.js");
  closeDb();
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FAIL] 未捕获异常：", err);
  console.error("[提示] 如实例已开机且不再使用，请前往 AutoDL 控制台手动关机，避免持续计费");
  process.exit(1);
});
