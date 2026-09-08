/**
 * 出片质量门禁(2026-08-14 精品化内在能力)。
 *
 * 渲染完成后自动对成片做机器可检的质量检查,输出 通过/警告/失败 三级报告:
 *   - 硬指标:时长、分辨率、帧率、音轨有无、响度(静音检测)
 *   - 画面健康:黑帧段(blackdetect)、冻结帧(freezedetect,主机位卡死)
 *   - 内容规范:字幕文件覆盖率
 *
 * 定位:机器能查的交给机器,把"低级错误"(静音、黑屏、卡死、缺字幕)
 * 拦截在发布前;审美层面的评估仍由 content-evaluator 的 LLM 评审负责。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { probeMedia } from "../video/ffmpeg.js";
import { listRenderJobs } from "../db/render-jobs-repo.js";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

/** 分镜时长口径单一事实源(2026-08-28 批次5.2):短视频平台硬上限 180s + 容差 5s。
 *  此前时长三头定义(脚本按分钟 floor/门禁 185s/质量门禁 600s 才 warn)——统一引用本常量。 */
export const MAX_PLAN_DURATION_S = 180;
export const DURATION_TOLERANCE_S = 5;

export type CheckLevel = "pass" | "warn" | "fail";

export interface QualityCheck {
  key: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export interface QualityReport {
  videoPath: string;
  passed: boolean;
  score: number; // 0-100:pass=满分,warn 减半,fail 零分(按项平均)
  checks: QualityCheck[];
  createdAt: string;
}

async function ffmpegDetect(args: string[]): Promise<string> {
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, { timeout: 120_000 });
    return stderr;
  } catch (e) {
    // ffmpeg 检测类命令以非零退出属正常(无输出文件)
    return (e as { stderr?: string }).stderr ?? "";
  }
}

/** 响度实测(ebur128):Integrated I 与 True Peak。解析失败返回 null(P2-T3 起废弃 volumedetect mean) */
export function parseEbur128(stderr: string): { i: number; tp: number } | null {
  // 取 Summary 段的终值(多次出现时是分段瞬时/累计值,Summary 才是全片)
  const summary = stderr.slice(Math.max(stderr.lastIndexOf("Summary:"), 0));
  const iM = summary.match(/I:\s*(-?[\d.]+|-?inf)\s*LUFS/i);
  const tpM = summary.match(/Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/i);
  if (!iM) return null;
  const i = /inf/i.test(iM[1]) ? -Infinity : parseFloat(iM[1]);
  const tp = !tpM ? NaN : (/inf/i.test(tpM[1]) ? -Infinity : parseFloat(tpM[1]));
  return { i, tp };
}

async function loudness(path: string): Promise<{ i: number; tp: number } | null> {
  const stderr = await ffmpegDetect(["-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  return parseEbur128(stderr);
}

/** 黑帧段(blackdetect):返回超过阈值的段列表 */
export async function blackSegments(path: string): Promise<string[]> {
  const stderr = await ffmpegDetect(["-i", path, "-vf", "blackdetect=d=1.5:pix_th=0.10", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/blackdetect.*black_start:[\d.]+ black_end:[\d.]+ black_duration:[\d.]+/g)].map((m) => m[0]);
}

/** 冻结段(freezedetect):返回冻结段列表 */
async function freezeSegments(path: string): Promise<string[]> {
  const stderr = await ffmpegDetect(["-i", path, "-vf", "freezedetect=n=0.003:d=3", "-an", "-f", "null", "-"]);
  return [...stderr.matchAll(/freeze_start:[\d.]+/g)].map((m) => m[0]);
}

export async function runQualityGate(videoPath: string, opts?: { subtitlePath?: string; expectedWidth?: number; expectedHeight?: number; expectAudio?: boolean }): Promise<QualityReport> {
  const checks: QualityCheck[] = [];
  const add = (key: string, label: string, level: CheckLevel, detail: string) => checks.push({ key, label, level, detail });
  // 中间段(模板图解/无声片段)不强制音轨;成片默认 expectAudio=true
  const expectAudio = opts?.expectAudio !== false;

  if (!existsSync(videoPath)) {
    return { videoPath, passed: false, score: 0, createdAt: new Date().toISOString(), checks: [{ key: "exists", label: "文件存在", level: "fail", detail: "成片文件不存在" }] };
  }

  const info = await probeMedia(videoPath);

  // 1. 时长(中间段 expectAudio=false 时短时长属正常,不告警)
  const dur = info.duration ?? 0;
  if (dur <= 0) add("duration", "时长", "fail", "无法读取时长");
  else if (dur < 5 && expectAudio) add("duration", "时长", "warn", `${dur.toFixed(1)}s 过短,平台分发价值低`);
  else if (dur > 600) add("duration", "时长", "warn", `${(dur / 60).toFixed(1)} 分钟偏长,短视频建议 ≤3 分钟`);
  else add("duration", "时长", "pass", `${dur.toFixed(1)}s`);

  // 2. 分辨率
  if (info.width && info.height) {
    const expected = opts?.expectedWidth && opts?.expectedHeight;
    if (expected && (info.width !== opts.expectedWidth || info.height !== opts.expectedHeight)) {
      add("resolution", "分辨率", "warn", `${info.width}x${info.height},与模板画布 ${opts.expectedWidth}x${opts.expectedHeight} 不一致`);
    } else if (info.width < 720) add("resolution", "分辨率", "warn", `${info.width}x${info.height} 低于 720p`);
    else add("resolution", "分辨率", "pass", `${info.width}x${info.height}`);
  } else {
    add("resolution", "分辨率", "fail", "无视频流");
  }

  // 3. 音轨 + 响度(ebur128 实测:I∈[-16,-14] LUFS、TP≤-1.5 dBFS 为平台甜点区,P2-T3)
  if (!info.hasAudio) {
    if (expectAudio) add("audio", "音轨", "fail", "成片没有音轨(无声视频)");
    else add("audio", "音轨", "pass", "无声段(模板图解/中间段),按预期无音轨");
  } else {
    const loud = await loudness(videoPath);
    // 中间段(Revideo/模板图解)导出器会带静默音轨:expectAudio=false 时静默属预期,不判 fail
    if (!expectAudio && loud !== null && loud.i === -Infinity) {
      add("audio", "响度", "pass", "无声中间段(静默音轨),按预期不检查响度");
    }
    else if (loud === null) add("audio", "响度", "warn", "响度检测失败");
    else if (loud.i === -Infinity || loud.i < -35) add("audio", "响度", "fail", `综合响度 ${loud.i === -Infinity ? "-∞" : loud.i.toFixed(1)} LUFS,接近静音`);
    else if (loud.i >= -16 && loud.i <= -14 && (Number.isNaN(loud.tp) || loud.tp <= -1.5)) {
      add("audio", "响度", "pass", `I=${loud.i.toFixed(1)} LUFS,TP=${Number.isNaN(loud.tp) ? "n/a" : loud.tp.toFixed(1)} dBFS(甜点区)`);
    }
    else if (loud.i >= -20 && loud.i <= -11) {
      add("audio", "响度", "warn", `I=${loud.i.toFixed(1)} LUFS 偏离甜点区[-16,-14]${!Number.isNaN(loud.tp) && loud.tp > -1.5 ? `,TP=${loud.tp.toFixed(1)} 超 -1.5` : ""}`);
    }
    else add("audio", "响度", "fail", `I=${loud.i.toFixed(1)} LUFS 严重偏离[-16,-14](响度战争或过轻)`);
  }

  // 3b. 采样率/声道硬检查（Q1：96kHz 事故机器拦截——criteria 已列为 Critical，实现层补齐）
  // X14 验收修复(2026-09-07):ffprobe 解析不到采样率/声道时此前静默 pass("n/a")——
  // fail-open 恰是 96kHz 事故漏网的路径。改为 fail-closed:探测失败即 fail,交人工复核。
  if (info.hasAudio) {
    if (info.sampleRate === undefined) {
      add("audio_sample_rate", "采样率", "fail", "音频流采样率探测失败(ffprobe 未解析到)——无法判定 44.1k/48k 合规性,需人工复核");
    } else if (![44100, 48000].includes(info.sampleRate)) {
      add("audio_sample_rate", "采样率", "fail", `采样率 ${info.sampleRate}Hz 非 44.1k/48k（平台兼容性 Critical）`);
    } else {
      add("audio_sample_rate", "采样率", "pass", `${info.sampleRate}Hz`);
    }
    if (info.channels === undefined) {
      add("audio_channels", "声道", "fail", "音频流声道数探测失败(ffprobe 未解析到)——无法判定立体声合规性,需人工复核");
    } else if (info.channels < 2) {
      add("audio_channels", "声道", "fail", `单声道(${info.channels}ch)——成片要求立体声`);
    } else {
      add("audio_channels", "声道", "pass", `${info.channels}ch`);
    }
  }

  // 4. 黑帧
  const blacks = await blackSegments(videoPath);
  if (blacks.length === 0) add("blackframe", "黑帧", "pass", "无超过 1.5s 的黑帧段");
  else add("blackframe", "黑帧", "fail", `检出 ${blacks.length} 段黑帧:${blacks[0]}`);

  // 5. 冻结帧
  const freezes = await freezeSegments(videoPath);
  if (freezes.length === 0) add("freeze", "冻结帧", "pass", "无超过 3s 的画面冻结");
  else add("freeze", "冻结帧", "warn", `检出 ${freezes.length} 段画面冻结(素材短于层时长定格?)`);

  // 6. 字幕
  if (opts?.subtitlePath) {
    if (existsSync(opts.subtitlePath)) {
      const content = readFileSync(opts.subtitlePath, "utf-8");
      const entries = (content.match(/\d{2}:\d{2}:\d{2}/g) ?? []).length;
      if (entries >= 2) add("subtitle", "字幕", "pass", `字幕文件 ${entries / 2 | 0} 条`);
      else add("subtitle", "字幕", "warn", "字幕文件为空或无有效条目");
    } else {
      add("subtitle", "字幕", "fail", "声明了字幕但文件不存在");
    }
  }

  const score = checks.length === 0 ? 0
    : Math.round((checks.reduce((s, c) => s + (c.level === "pass" ? 1 : c.level === "warn" ? 0.5 : 0), 0) / checks.length) * 100);
  return {
    videoPath,
    passed: checks.every((c) => c.level !== "fail"),
    score,
    checks,
    createdAt: new Date().toISOString(),
  };
}

// ── A1/B2 机器门禁:assembly 交付物断言(P2-T3,2026-08-17)─────────────────────
// advance(assembly) 前置校验:成品文件/发布文案/质检报告时效/字幕规范,
// 任一缺失给可读清单,拦截在评审与发布之前。

export interface DeliverableIssue {
  key: string;
  detail: string;
}

// ── plan 机器预检(2026-08-26)─────────────────────────────────────────────────
// 背景:w_20260826_1647_05d plan 三轮评审全挂、w_20260826_1652_224 plan 前两轮挂,
// 失分点高度重复且全部机械可校验(时长超限/旁白超20字/引用已剔除素材/极限词)。
// 机器能查的不烧 LLM 评审轮次——以下四项在 advance(plan) 前置拦截,
// 与 assembly 门禁同构;LLM 评审专注 Hook/叙事/视觉等真正需要判断力的维度。
//
// 设计原则:宁漏勿错。plan.md 是 LLM 自由格式 markdown,解析必须保守——
// 只在格式可明确识别时出具问题,拿不准的一律放行交 LLM 评审判断。

/** 旁白计字:所有非空白字符(与评审口径一致——实测评审把 "再叠加三维 GIS 和 BIM，每块砖都有数字坐标。" 计为 23 字) */
function countNarrationChars(s: string): number {
  const m = s.match(/\S/g);
  return m ? m.length : 0;
}

/** 视觉标注识别:画面大字/花字/字幕等括号注释是屏幕文字而非口播,不适用 20 字铁律 */
function isVisualNote(sentence: string): boolean {
  return /^["'“”]*[(（]/.test(sentence) && /画面|大字|花字|字幕|标题卡|角标/.test(sentence);
}

/** 从 markdown 表格行切分单元格(容错:首尾竖线可有可无) */
function splitMdRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

/** 解析时长单元格:"4s"/"4秒"/"4-6s"取上限;无法解析返回 null */
function parseDurationCell(cell: string): number | null {
  const m = cell.match(/(\d+(?:\.\d+)?)(?:\s*[-–~]\s*(\d+(?:\.\d+)?))?\s*(?:s|秒)?/i);
  if (!m) return null;
  const hi = m[2] ? parseFloat(m[2]) : parseFloat(m[1]);
  return Number.isFinite(hi) ? hi : null;
}

/**
 * plan 推进前置校验:返回问题清单(空数组=通过)。
 * ① 分镜表时长合计 ≤ 上限(默认 MAX_PLAN_DURATION_S 180s,容差 5s;用户显式时长豁免)
 * ② 显式旁白行(旁白:/口播: 前缀或分镜表旁白列)单句 ≤20 字
 * ③ 不得引用 material-candidates.md 剔除区的素材文件
 * ④ 标题/封面行极限词(最/第一/唯一/首个)须有"之一"限定
 */
export function assertPlanDeliverables(workDir: string, maxDurationS = MAX_PLAN_DURATION_S): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];

  // 定位分镜文档:根目录 plan.md 优先,其次 plan/plan.md(v2 契约),再次 assets/plan-storyboard.md
  const planCandidates = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md"), join(workDir, "assets", "plan-storyboard.md")];
  const planPath = planCandidates.find((p) => existsSync(p));
  if (!planPath) {
    return [{ key: "plan_doc", detail: "分镜文档缺失(plan.md、plan/plan.md、assets/plan-storyboard.md 均不存在)" }];
  }
  const lines = readFileSync(planPath, "utf-8").split("\n");

  // ── ①② 分镜表:表头含"镜号"且含"时长"的 markdown 表 ──
  let totalDuration = 0;
  let durationParsed = 0;
  let narrationCol = -1;
  let durationCol = -1;
  let inShotTable = false;
  for (const line of lines) {
    if (!line.includes("|")) { inShotTable = false; continue; }
    const cells = splitMdRow(line);
    const isHeader = cells.some((c) => /镜号|^镜$|shot/i.test(c)) && cells.some((c) => /时长/.test(c));
    if (isHeader) {
      inShotTable = true;
      narrationCol = cells.findIndex((c) => /旁白|口播|narration/i.test(c));
      // 时长列从表头定位——逐行猜列会把镜号列("01"=1s)当时长累加(实测 25 镜累加成 325s)
      durationCol = cells.findIndex((c) => /时长/.test(c));
      continue;
    }
    if (!inShotTable) continue;
    if (/^[-:\s|]+$/.test(line)) continue; // 分隔行
    if (durationCol >= 0 && cells[durationCol]) {
      const d = parseDurationCell(cells[durationCol]);
      if (d !== null && d <= 60) { totalDuration += d; durationParsed++; }
    }
    if (narrationCol >= 0 && cells[narrationCol]) {
      for (const sentence of cells[narrationCol].split(/[。!?;；]/).map((s) => s.trim()).filter(Boolean)) {
        if (isVisualNote(sentence)) continue;
        const n = countNarrationChars(sentence);
        if (n > 20 && issues.filter((i) => i.key === "narration_len").length < 5) {
          issues.push({ key: "narration_len", detail: `旁白超 20 字(${n}字):「${sentence.slice(0, 30)}」` });
        }
      }
    }
  }
  // 解析到 ≥5 个镜头时长才出具合计结论(拿不准不放行交给 LLM)
  // 批次5.8:用户显式时长是最高优先级事实源——显式指定时以用户值为上限(加容差),
  // 不再套用平台默认 180s("用户要 5 分钟被砍到 2:17"的制度修复)
  const durationLimit = maxDurationS + DURATION_TOLERANCE_S;
  if (durationParsed >= 5 && totalDuration > durationLimit) {
    issues.push({ key: "duration_total", detail: `分镜表时长合计 ${Math.round(totalDuration)}s,超过上限 ${maxDurationS}s(评审 Critical 项)` });
  }

  // ── ②b 显式旁白全文行(旁白:/口播: 前缀,分镜表之外的口播稿)──
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:旁白|口播)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    for (const sentence of m[1].split(/[。!?;；]/).map((s) => s.trim()).filter(Boolean)) {
      if (isVisualNote(sentence)) continue;
      const n = countNarrationChars(sentence);
      if (n > 20 && issues.filter((i) => i.key === "narration_len").length < 8) {
        issues.push({ key: "narration_len", detail: `旁白超 20 字(${n}字):「${sentence.slice(0, 30)}」` });
      }
    }
  }

  // ── ③ 剔除素材交叉核对:material-candidates.md 剔除区出现的文件名,plan 不得引用 ──
  const candidatesPath = join(workDir, "assets", "material-candidates.md");
  if (existsSync(candidatesPath)) {
    const candLines = readFileSync(candidatesPath, "utf-8").split("\n");
    const eliminated = new Set<string>();
    let inElimSection = false;
    for (const l of candLines) {
      if (/^#{1,4}\s/.test(l)) inElimSection = /剔除|淘汰|不可用|废弃/.test(l);
      // 剔除区整段 + 任意行内显式标"剔除"的文件名都计入
      const files = l.match(/[\w-]+\.(?:mp4|mov|webm|jpg|jpeg|png)/gi) ?? [];
      if (inElimSection || /剔除|淘汰/.test(l)) files.forEach((f) => eliminated.add(f.toLowerCase()));
    }
    if (eliminated.size > 0) {
      const planText = lines.join("\n").toLowerCase();
      for (const f of eliminated) {
        if (planText.includes(f)) {
          issues.push({ key: "eliminated_ref", detail: `引用了已被剔除的素材「${f}」——请从 material-candidates.md 保留清单中选替换项` });
        }
      }
    }
  }

  // ── ④ 极限词:标题/封面行出现 最/第一/唯一/首个 且无"之一"限定 ──
  for (const line of lines) {
    if (!/标题|封面|title|cover/i.test(line)) continue;
    if (/之一/.test(line)) continue;
    const m = line.match(/[一-鿿]*(?:最大|最全|首个|第一|唯一|国家级|世界级)[一-鿿]*/);
    if (m && issues.filter((i) => i.key === "superlative").length < 3) {
      issues.push({ key: "superlative", detail: `标题/封面疑似极限词缺「之一」限定:「${m[0]}」(行:${line.trim().slice(0, 40)})` });
    }
  }

  return issues;
}


/** ass Dialogue 单可视行 ≤15 字、CPS ≤8 校验;返回违规描述列表 */
export function checkAssSubtitles(assContent: string): string[] {
  const violations: string[] = [];
  const lines = assContent.split("\n").filter((l) => l.startsWith("Dialogue:"));
  lines.forEach((line, idx) => {
    // ass: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const parts = line.split(",");
    if (parts.length < 10) return;
    const [start, end] = [parts[1].trim(), parts[2].trim()];
    const text = parts.slice(9).join(",").replace(/\{[^}]*\}/g, "").trim();
    const toSec = (t: string): number => {
      const m = t.match(/(\d+):(\d+):(\d+)[.:](\d+)/);
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100 : 0;
    };
    const dur = toSec(end) - toSec(start);
    for (const visualLine of text.split(/\N/i)) {
      const len = [...visualLine.trim()].length;
      if (len > 15) violations.push(`第${idx + 1}条单行 ${len} 字(>15):「${visualLine.trim().slice(0, 20)}…」`);
    }
    const chars = [...text.replace(/\N/gi, "")].length;
    if (dur > 0.2 && chars / dur > 8) violations.push(`第${idx + 1}条 CPS=${(chars / dur).toFixed(1)}(>8):「${text.slice(0, 16)}…」`);
  });
  return violations;
}

/**
 * assembly 推进前置校验:返回问题清单(空数组=通过)。
 * 检查:① output/*final*.mp4 存在 ② publish-text.md 存在
 * ③ quality-report.json 存在且 videoPath 指向 final 且报告不早于 final(QC 未跑在旧片上)
 * ④ 字幕 ass 单行 ≤15 字、CPS ≤8
 * ⑤(批次11.4)绑定模板的作品:模板渲染段必须实际进入成片(渲染了但弃用 = 绕开模板契约)
 */
export function assertAssemblyDeliverables(workDir: string, opts?: { templateId?: string; workId?: string }): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const outDir = join(workDir, "output");
  if (!existsSync(outDir)) {
    return [{ key: "output_dir", detail: "output/ 目录不存在——成片/文案/质检报告均未产出" }];
  }
  const files = readdirSync(outDir);

  // ① 成片
  // 2026-08-19 P0 修复:宽松 /final/i 会命中 job_*_final.mp4 分段(2026-08-16 同类
  // bug 在 reconcile/work-queue 修过,此处漏修)。^final 锚定:final.mp4 /
  // final_douyin.mp4 双平台变体均可,job_ 前缀分段永远排除。
  const finalVideo = files.find((f) => /^final[^/]*\.(mp4|mov|webm)$/i.test(f));
  if (!finalVideo) issues.push({ key: "final_video", detail: "output/ 下无文件名含 final 的成片视频(final.mp4 或 final_平台.mp4)" });

  // ② 发布文案
  if (!files.includes("publish-text.md")) {
    issues.push({ key: "publish_text", detail: "output/publish-text.md 缺失(发布文案未产出)" });
  }

  // ③ 质检报告时效 + 结论(2026-09-01 终审 C2:此前只验存在性,passed=false 的黑片可过闸)
  const reportFile = files.find((f) => f === "quality-report.json");
  if (!reportFile) {
    issues.push({ key: "quality_report", detail: "output/quality-report.json 缺失(成片未过质量门禁)" });
  } else if (finalVideo) {
    try {
      const report = JSON.parse(readFileSync(join(outDir, reportFile), "utf-8")) as { videoPath?: string; createdAt?: string; passed?: boolean; issues?: Array<{ level?: string; message?: string }> };
      if (report.passed === false) {
        const fails = (report.issues ?? []).filter((i) => i.level === "fail" || i.level === "critical").map((i) => i.message ?? "").filter(Boolean).slice(0, 3);
        issues.push({ key: "quality_report", detail: `质量门禁结论为 fail——成片带病,请修复后重跑 QC${fails.length ? `(fail 项: ${fails.join("; ")})` : ""}` });
      } else if (!report.videoPath || basename(report.videoPath) !== finalVideo) {
        issues.push({ key: "quality_report", detail: `quality-report.json 的 videoPath(${report.videoPath ?? "空"})不指向当前成片 ${finalVideo}——QC 跑在了旧文件上` });
      } else {
        const finalMtime = statSync(join(outDir, finalVideo)).mtimeMs;
        if (statSync(join(outDir, reportFile)).mtimeMs < finalMtime) {
          issues.push({ key: "quality_report", detail: "quality-report.json 早于成片最后修改时间——成片重渲染后未重跑 QC" });
        } else {
          // 2026-08-31 实测(dde):agent 重渲染出全片黑帧后,复制旧报告刷新 mtime 混过门禁
          // (报告 createdAt 18:30 比 19:03 的成片旧,内容是对旧版的分析)。内容级时间戳才是真相。
          const createdAtMs = Date.parse(report.createdAt ?? "");
          if (Number.isFinite(createdAtMs) && createdAtMs < finalMtime - 5000) {
            issues.push({ key: "quality_report", detail: "quality-report.json 的内容时间(createdAt)早于成片最后修改时间——仅刷新文件时间不算重跑 QC,请重新运行质量门禁" });
          }
        }
      }
    } catch {
      issues.push({ key: "quality_report", detail: "quality-report.json 解析失败(损坏)" });
    }
  }

  // ④ 字幕规范
  const assFile = files.find((f) => /\.ass$/i.test(f));
  if (!assFile) {
    issues.push({ key: "subtitles", detail: "output/ 下无 .ass 字幕文件" });
  } else {
    const violations = checkAssSubtitles(readFileSync(join(outDir, assFile), "utf-8"));
    for (const v of violations.slice(0, 5)) issues.push({ key: "subtitles", detail: v });
    if (violations.length > 5) issues.push({ key: "subtitles", detail: `……另有 ${violations.length - 5} 条字幕违规` });
  }

  // ── ⑤ 模板契约(批次11.4):绑定模板的作品,模板渲染段必须实际入片。
  // a4d 渲染了 6s 模板片头却弃用——"渲染过" ≠ "用了"。以合成清单(assembly-plan.json
  // 或 norm/concat.txt)是否引用模板渲染产物文件名为准。
  // M3:用户「选择不绑定」是合法状态——无 templateId 不做模板契约检查（不 fail）；
  // 仅当绑定了模板（opts.templateId 非空）时，下方 template_skin 检查模板段必须入片。
  if (opts?.templateId && opts?.workId) {
    try {
      const tplJobs = listRenderJobs("completed", opts.workId)
        .filter((j) => j.template_id === opts.templateId && j.output_path);
      if (tplJobs.length === 0) {
        issues.push({ key: "template_skin", detail: `作品绑定了模板(${opts.templateId})但从未渲染模板段——模板契约要求模板视觉呈现实际进入成片` });
      } else {
        const jobFiles = new Set(tplJobs.map((j) => basename(j.output_path!).toLowerCase()));
        // 2026-09-08 修复(ef9 实测):清单路径假设写死导致永远 fail——agent 实际把
        // assembly-plan.json/concat.txt 写在 output/(或作品根),门禁却仅读 assets/ 两个
        // 不存在的位置,元本为空即误判"渲染了但弃用"。覆盖合成清单的全部真实位置。
        const manifestTexts: string[] = [];
        for (const p of [
          join(workDir, "assets", "assembly-plan.json"),
          join(workDir, "assets", "norm", "concat.txt"),
          join(workDir, "output", "assembly-plan.json"),
          join(workDir, "output", "concat.txt"),
          join(workDir, "assembly-plan.json"),
          join(workDir, "concat.txt"),
        ]) {
          if (existsSync(p)) manifestTexts.push(readFileSync(p, "utf-8").toLowerCase());
        }
        if (manifestTexts.length === 0) {
          // 模板段已渲染但无任何合成清单文件——仍不可放行(无清单=无法证明入片),
          // 但报错要点明"缺清单"而非误称"弃用"
          issues.push({
            key: "template_skin",
            detail: `模板段已渲染(${tplJobs.length} 个)但找不到合成清单(output/concat.txt 或 output/assembly-plan.json)——无法证明模板段入片,请产出合成清单后重试`,
          });
        } else {
          const used = [...jobFiles].some((f) => manifestTexts.some((t) => t.includes(f)));
          if (!used) {
            issues.push({
              key: "template_skin",
              detail: `模板段已渲染(${tplJobs.length} 个)但未进入成片合成清单——禁止"渲染了但弃用"。请将模板段(片头/片尾/模版卡)接入 concat/assembly-plan,或说明模板为何不适用并解除绑定`,
            });
          }
        }
      }
    } catch { /* 模板校验自身失败不阻断 */ }
  }

  return issues;
}

/** 批次5.7 material-search 机器门禁:候选清单存在且含实质素材引用(空清单不得过闸) */
export function assertMaterialSearchDeliverables(workDir: string): DeliverableIssue[] {
  const candidatesPath = [join(workDir, "assets", "material-candidates.md"), join(workDir, "material-candidates.md")].find(existsSync);
  if (!candidatesPath) {
    return [{ key: "candidates_doc", detail: "素材候选清单缺失(assets/material-candidates.md 不存在)" }];
  }
  const text = readFileSync(candidatesPath, "utf-8");
  const fileRefs = text.match(/[\w一-鿿-]+\.(?:mp4|mov|webm|jpg|jpeg|png)/gi) ?? [];
  const urlRefs = text.match(/https?:\/\/[^\s)\]"']+/g) ?? [];
  if (fileRefs.length === 0 && urlRefs.length === 0) {
    return [{ key: "candidates_empty", detail: "候选清单无任何素材文件引用或来源 URL——空清单不得过闸" }];
  }
  return [];
}

/** 批次5.7 assets 机器门禁:素材目录有实质媒体产物(零产出不得过闸) */
export function assertAssetsDeliverables(workDir: string): DeliverableIssue[] {
  const mediaExt = /\.(mp4|mov|webm|jpg|jpeg|png)$/i;
  let mediaCount = 0;
  for (const sub of ["assets/clips", "assets/images"]) {
    try {
      mediaCount += readdirSync(join(workDir, sub)).filter((f) => mediaExt.test(f)).length;
    } catch { /* 目录不存在 */ }
  }
  if (mediaCount === 0) {
    return [{ key: "assets_empty", detail: "assets/clips 与 assets/images 均无任何媒体文件——素材阶段零产出不得过闸" }];
  }
  return [];
}

/** 批次6.2 图文等价门禁(v2-M2):图文作品的 assembly 此前被门禁整体跳过,空图文可过审。
 *  校验:output/cards/ 存在 ≥2 张 PNG、含 01-cover 封面、无空白小文件 */
export function assertImageTextDeliverables(workDir: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const cardsDir = join(workDir, "output", "cards");
  let cards: string[] = [];
  try {
    cards = readdirSync(cardsDir).filter((f) => /\.png$/i.test(f));
  } catch { /* 目录不存在 */ }
  if (cards.length < 2) {
    issues.push({ key: "cards_missing", detail: `图文卡片不足(output/cards/ 仅 ${cards.length} 张 PNG,至少需封面+1 张内容卡)` });
    return issues;
  }
  if (!cards.some((f) => /cover/i.test(f))) {
    issues.push({ key: "cover_missing", detail: "封面卡缺失(output/cards/ 下无 *cover*.png)" });
  }
  for (const f of cards) {
    try {
      if (statSync(join(cardsDir, f)).size < 10_000) {
        issues.push({ key: "card_blank", detail: `卡片疑似空白/渲染残缺:${f}(${statSync(join(cardsDir, f)).size}B < 10KB)` });
      }
    } catch { /* 单文件失败跳过 */ }
  }
  return issues;
}

/** Q1 素材引用存在性检查：分镜表"素材"列引用的每个文件名，必须在
 *  material-candidates.md 保留清单 / 共享库 scenes 清单 / 程序化模板清单 三者并集中存在。
 *  缺失即 fail（修 eval-plan-1 critical：63s 镜头引用不存在素材）。 */
export function assertPlanReferences(workDir: string, candidateSources: Array<{ dir: string; files: string[] }> = []): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const planPath = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md")].find(existsSync);
  if (!planPath) return issues; // 无分镜不检查（由 plan 阶段前置校验兜底）

  // 构建"素材文件名 → 来源"并集
  const known = new Set<string>();
  const candidatesPath = [join(workDir, "assets", "material-candidates.md"), join(workDir, "material-candidates.md")].find(existsSync);
  if (candidatesPath) {
    const text = readFileSync(candidatesPath, "utf-8");
    for (const m of text.matchAll(/\[([^\]]+)]\(([^)]+\.(?:mp4|mov|png|jpg|jpeg|webp|wav|mp3))[^)]*\)/gi)) {
      known.add(m[2].split(/[\\/]/).pop()!.toLowerCase());
    }
    for (const m of text.matchAll(/`?([^\s`]+\.(?:mp4|mov|png|jpg|jpeg|webp|wav|mp3))`?/gi)) {
      known.add(m[1].split(/[\\/]/).pop()!.toLowerCase());
    }
  }
  for (const src of candidateSources) {
    for (const f of src.files) known.add(f.split(/[\\/]/).pop()!.toLowerCase());
  }
  // B12(2026-09-08):指令/评审都声称"引用必须在 registry.json 登记、门禁逐条核验",
  // 此前 known 并集并不含 registry——登记了但 candidates 未列的引用被误拦。
  const registryPath = join(workDir, "assets", "registry.json");
  if (existsSync(registryPath)) {
    try {
      const reg = JSON.parse(readFileSync(registryPath, "utf-8")) as { sources?: Array<{ name?: string }> };
      for (const s of reg.sources ?? []) {
        if (s.name) known.add(s.name.split(/[\\/]/).pop()!.toLowerCase());
      }
    } catch { /* registry 解析失败按未登记处理 */ }
  }

  const planText = readFileSync(planPath, "utf-8");
  for (const m of planText.matchAll(/([^\s|,;：:()\]]+\.(?:mp4|mov|png|jpg|jpeg|webp|wav|mp3))/gi)) {
    const fname = m[1].trim().split(/[\\/]/).pop()!.toLowerCase();
    if (!known.has(fname) && !/customHtml|code-scene|scene-(\d+)-|chart|snapshot/i.test(fname)) {
      issues.push({ key: "plan_ref_missing", detail: `分镜引用了不存在的素材「${fname}」——需在 material-candidates 保留清单/素材库/程序化模板中添加，或改引现有素材` });
    }
  }
  return issues;
}

/** F3 待核禁进口播（方案定稿）：脚本/分镜中"政策文号/年份/百分比/机构名"等事实型断言，
 *  若核验态为待核（verify_status=unverified）且出现在口播（TTS 文本）→ critical。
 *  仅允许出现在"画面披露 + 以官方发布为准"场景。
 *  匹配：文号〔XXXX〕第X号、年份 XXXX 年、百分比 X%；"已核验/据…发布"标记豁免。 */
export function assertFactClaims(scriptText: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const claims = scriptText.matchAll(/([〔【][0-9]{4}[〕】](?:第?\s*\d+\s*号)|[0-9]{4}\s*年|[０-９.]+%|[\d.]+%)/g);
  for (const m of claims) {
    const claim = m[0];
    // X14 验收修复(2026-09-07):旧豁免 `new RegExp("已核验|据…").test(claim)` 是死代码——
    // claim 正则只捕获文号/年份/百分比本身,永远不可能含"已核验"。改为核验
    // 断言前后上下文窗口(前 80 字 + 后 120 字,覆盖"已核验"前缀与"来源/URL"后缀两种标注习惯);
    // 并落实方案的豁免场景:画面披露+"以官方发布为准"降格不拦。
    const ctx = scriptText.slice(Math.max(0, m.index! - 80), m.index! + claim.length + 120);
    const verified = /已核验|据[^。\n]{0,20}(发布|通知|印发)|来源[:：]|https?:\/\//i.test(ctx);
    const disclosedOnly = /以官方发布为准|画面披露/.test(ctx);
    if (!verified && !disclosedOnly) {
      issues.push({ key: "claim_unverified", detail: `事实断言「${claim}」未核验（verify_status=unverified）不得进口播——先 WebSearch 核验并附来源 URL，或改为画面披露+“以官方发布为准”` });
    }
  }
  return issues;
}

/** Q1+F3 组合接线（2026-09 补修）：plan 阶段机器预检的扩展——
 *  素材引用存在性（assertPlanReferences）+ 事实断言核验态（assertFactClaims）。
 *  advance(plan) 预检链在 assertPlanDeliverables 之外追加调用本函数。 */
export function assertPlanGateExtensions(workDir: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  issues.push(...assertPlanReferences(workDir));
  const planPath = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md")].find(existsSync);
  if (planPath) {
    issues.push(...assertFactClaims(readFileSync(planPath, "utf-8")));
  }
  return issues;
}

/** M1(方案定稿):advance 绑定一致性断言——works.template_id 与 plan.md 声称的模板 ID 必须一致。
 *  消除"agent 自认模板 tpl_code_f752958d"污染评审（ae0 事故诱因）。 */
export function assertTemplateBindingConsistency(workDir: string, workTemplateId?: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  if (!workTemplateId) return issues; // 未绑模板由 M3 兜底 fail，这里只查"绑了但声称不一致"
  const planPath = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md")].find(existsSync);
  if (!planPath) return issues;
  const text = readFileSync(planPath, "utf-8");
  const claimed = text.match(/(?:模板|template)\s*(?:ID|id)?\s*[：:]\s*(tpl_[a-zA-Z0-9_-]+)/i);
  if (claimed && claimed[1].toLowerCase() !== workTemplateId.toLowerCase()) {
    issues.push({ key: "template_mismatch", detail: `plan.md 声称模板 ${claimed[1]} 与作品绑定模板 ${workTemplateId} 不一致——请统一模板口径，消除"agent 自认模板"污染评审` });
  }
  return issues;
}

/** P1(2026-09 大工程):plan-validator 结构校验——从 plan.md 分镜表解析可机器校验的结构维度。
 *  ① 景别标注覆盖率 ≥80%（分镜语法要求每镜显式标注景别，相邻镜头有变化）；
 *  ② 制作方式标注率 =100%（content-planning SKILL 要求每镜必标 chart/snapshot/diagram/... ）；
 *  ③ 旁白字数×语速 vs 分镜总时长（语速 4.5 字/秒，只拦明显不符：>8 字/秒 或 <1.5 字/秒）。
 *  保守原则：仅在分镜表表头明确含对应列时才校验，拿不准一律放行交 LLM 评审（宁漏勿错）。 */
export function assertPlanStructure(workDir: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const planPath = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md")].find(existsSync);
  if (!planPath) return issues;
  const lines = readFileSync(planPath, "utf-8").split("\n");

  let inShotTable = false;
  let shotCount = 0;
  let sizeCol = -1, sizeFilled = 0;
  let routeCol = -1, routeFilled = 0;
  let narrationCol = -1, durationCol = -1;
  let totalDuration = 0, totalNarrationChars = 0;

  for (const line of lines) {
    if (!line.includes("|")) { inShotTable = false; continue; }
    const cells = splitMdRow(line);
    const isHeader = cells.some((c) => /镜号|^镜$|shot/i.test(c)) && cells.some((c) => /时长/.test(c));
    if (isHeader) {
      inShotTable = true;
      sizeCol = cells.findIndex((c) => /景别|shot[ _-]?size|shotsize/i.test(c));
      routeCol = cells.findIndex((c) => /制作方式|制作|route|produce/i.test(c));
      narrationCol = cells.findIndex((c) => /旁白|口播|narration/i.test(c));
      durationCol = cells.findIndex((c) => /时长/.test(c));
      continue;
    }
    if (!inShotTable) continue;
    if (/^[-:\s|]+$/.test(line)) continue;
    shotCount++;
    if (sizeCol >= 0 && cells[sizeCol] && !/^[-—无\s]*$/.test(cells[sizeCol].trim())) sizeFilled++;
    if (routeCol >= 0 && cells[routeCol] && !/^[-—无\s]*$/.test(cells[routeCol].trim())) routeFilled++;
    if (durationCol >= 0 && cells[durationCol]) {
      const d = parseDurationCell(cells[durationCol]);
      if (d !== null && d <= 60) totalDuration += d;
    }
    if (narrationCol >= 0 && cells[narrationCol]) totalNarrationChars += countNarrationChars(cells[narrationCol]);
  }

  // ① 景别覆盖率（≥80%，软性但有量化下限；解析到 ≥5 镜才出具结论）
  if (shotCount >= 5 && sizeCol >= 0) {
    const coverage = sizeFilled / shotCount;
    if (coverage < 0.8) {
      issues.push({ key: "shot_size_coverage", detail: `景别标注覆盖率 ${Math.round(coverage * 100)}%（${sizeFilled}/${shotCount} 镜）< 80%——分镜语法要求每镜显式标注景别（特写/中景/全景…）` });
    }
  }
  // ② 制作方式标注（必填，硬性）
  if (shotCount >= 5 && routeCol >= 0 && routeFilled < shotCount) {
    issues.push({ key: "shot_route_missing", detail: `制作方式标注率 ${Math.round((routeFilled / shotCount) * 100)}%（${routeFilled}/${shotCount} 镜）——每个镜头必须标注制作方式（chart/snapshot/diagram/digital_human/ai_video/stock/upload/reuse）` });
  }
  // ③ 字数×语速 vs 时长（语速 4.5 字/秒，只拦明显不符）
  if (shotCount >= 5 && totalDuration > 0 && totalNarrationChars > 0) {
    const rate = totalNarrationChars / totalDuration;
    if (rate > 8) {
      issues.push({ key: "narration_too_dense", detail: `旁白密度 ${rate.toFixed(1)} 字/秒（${totalNarrationChars} 字 / ${Math.round(totalDuration)}s）超过 8 字/秒上限——口播塞不下，请精简或加长画面` });
    } else if (rate < 1.5) {
      issues.push({ key: "narration_too_sparse", detail: `旁白密度 ${rate.toFixed(1)} 字/秒（${totalNarrationChars} 字 / ${Math.round(totalDuration)}s）低于 1.5 字/秒——画面严重空转，请补充口播或缩短时长` });
    }
  }
  return issues;
}

/** Q2(2026-09 大工程):shot-map 完整性检查——assets 阶段产出的逐镜抽帧台账。
 *  方案定稿：缺台账即 fail（每镜必须有 asset_file + 至少 1 帧）。 */
export function assertShotMapCompleteness(workDir: string): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const shotMapPath = [join(workDir, "assets", "shot-map.json"), join(workDir, "shot-map.json")].find(existsSync);
  if (!shotMapPath) {
    return [{ key: "shot_map_missing", detail: "assets 阶段未产出 shot-map.json——逐镜抽帧台账缺失（方案定稿：缺台账即 fail，请先按分镜产出台账再推进）" }];
  }

  try {
    const shotMap = JSON.parse(readFileSync(shotMapPath, "utf-8")) as { shots?: Array<{ asset_file?: string; frames?: string[] }> };
    const shots = Array.isArray(shotMap?.shots) ? shotMap.shots : [];
    if (shots.length === 0) {
      issues.push({ key: "shot_map_empty", detail: "shot-map.json 的 shots 为空——应逐镜登记素材与抽帧" });
      return issues;
    }
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i] ?? {};
      if (!s.asset_file) issues.push({ key: "shot_map_missing_asset", detail: `shot-map 第 ${i + 1} 镜缺 asset_file（素材文件未登记）` });
      if (!Array.isArray(s.frames) || s.frames.length === 0) issues.push({ key: "shot_map_missing_frame", detail: `shot-map 第 ${i + 1} 镜缺 frames（未抽首/中/尾帧）` });
    }
  } catch {
    issues.push({ key: "shot_map_invalid", detail: "shot-map.json 解析失败（损坏）——请重新生成" });
  }
  return issues;
}

/**
 * Q2/X15 验收修复(2026-09-07):shot-map 程序化生成兜底——此前台账靠 ws-bridge prompt
 * 要求 agent 手写(不写则门禁 fail、写了质量无保证)。现改为机器先做一遍:
 * advance(assets) 前若 shot-map.json 缺失,从 plan.md 的素材引用逐镜生成台账
 * (定位素材文件 + ffmpeg 抽首/中/尾帧;图片素材以原图为帧)。
 * 已存在的台账不覆盖(agent 写的更详细版本优先);生成失败不抛——缺失/不完整
 * 仍由 assertShotMapCompleteness 拦截,只是从"靠 agent 自觉"变成"机器打底"。
 */
export async function ensureShotMap(workDir: string): Promise<boolean> {
  const existing = [join(workDir, "assets", "shot-map.json"), join(workDir, "shot-map.json")].find(existsSync);
  if (existing) return false;
  const planPath = [join(workDir, "plan.md"), join(workDir, "plan", "plan.md")].find(existsSync);
  if (!planPath) return false;
  const planText = readFileSync(planPath, "utf-8");

  // 素材目录全量索引(文件名小写 → 绝对路径),递归覆盖 clips/images 及子目录
  const fileIndex = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      try { if (statSync(full).isDirectory()) { walk(full); continue; } } catch { continue; }
      if (/\.(mp4|mov|png|jpg|jpeg|webp)$/i.test(f)) fileIndex.set(f.toLowerCase(), full);
    }
  };
  walk(join(workDir, "assets", "clips"));
  walk(join(workDir, "assets", "images"));

  const { getFFmpegPath } = await import("../video/ffmpeg.js");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const ffmpeg = await getFFmpegPath();
  const framesDir = join(workDir, "assets", "frames", "shotmap");

  interface ShotRow { i: number; plan_spec: string; asset_file?: string; frames: string[]; narration: string; source: string }
  const shots: ShotRow[] = [];
  let idx = 0;
  for (const line of planText.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const m = line.match(/([^\s|,;：:()\]]+\.(?:mp4|mov|png|jpg|jpeg|webp))/i);
    if (!m) continue;
    idx++;
    const fname = basename(m[1]).toLowerCase();
    const assetPath = fileIndex.get(fname);
    const frames: string[] = [];
    if (assetPath) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(assetPath)) {
        frames.push(assetPath); // 图片素材原图即帧
      } else {
        try {
          const info = await probeMedia(assetPath);
          const dur = info.duration && info.duration > 0.3 ? info.duration : 3;
          await mkdir(framesDir, { recursive: true });
          for (const [k, t] of [0.1, dur / 2, Math.max(0.1, dur - 0.1)].entries()) {
            const fp = join(framesDir, `shot-${String(idx).padStart(2, "0")}-${k + 1}.jpg`);
            await execFileAsync(ffmpeg, ["-ss", t.toFixed(2), "-i", assetPath, "-frames:v", "1", "-q:v", "3", "-y", fp], { windowsHide: true });
            if (existsSync(fp)) frames.push(fp);
          }
        } catch { /* 单镜抽帧失败不阻断整体——该镜 frames 为空由完整性检查拦截 */ }
      }
    }
    shots.push({ i: idx, plan_spec: line.trim().slice(0, 200), asset_file: assetPath, frames, narration: "", source: "auto-generated" });
  }
  if (!shots.length) return false;
  await mkdir(join(workDir, "assets"), { recursive: true });
  await writeFile(
    join(workDir, "assets", "shot-map.json"),
    JSON.stringify({ generated: "machine", createdAt: new Date().toISOString(), shots }, null, 2),
    "utf-8",
  );
  return true;
}

/**
 * P1/X15 验收修复(2026-09-07):阶段契约文件存在性门禁——facts.json/script.json
 * (research)、registry.json(material-search)此前只有 prompt 要求,无机器检查,
 * 契约链"据此校验"未闭环。缺文件即 fail,error 里写清期望路径。
 */
export function assertContractArtifacts(workDir: string, step: "research" | "material-search" | "content-research" | "plan-assets", opts: { workType?: string } = {}): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const find = (name: string, sub: string) =>
    [join(workDir, name), join(workDir, sub, name), join(workDir, "assets", name)].find(existsSync);
  if (step === "research") {
    if (!find("facts.json", "research")) {
      issues.push({ key: "contract_facts_missing", detail: "research 阶段未产出 facts.json(事实断言+核验态+来源 URL 的机器可读契约)——请按调研方法论落盘 facts.json 后再推进" });
    }
    if (!find("script.json", "research")) {
      issues.push({ key: "contract_script_missing", detail: "research 阶段未产出 script.json(独立脚本+语速预算)——脚本嵌在 report.md 里无法机器校验语速,请落盘 script.json 后再推进" });
    }
  }
  if (step === "material-search") {
    if (!find("registry.json", "material-search")) {
      issues.push({ key: "contract_registry_missing", detail: "material-search 阶段未产出 assets/registry.json(素材库机器索引)——plan 预检的引用存在性校验依赖它,请补齐后再推进" });
    }
  }
  // 流水线 v2(2026-09-07 重构,批次2):新四步的契约文件
  if (step === "content-research") {
    if (!find("article.md", "research")) {
      issues.push({ key: "contract_article_md_missing", detail: "内容研究阶段未产出 research/article.md(最终作品文章)——成文落盘后再推进" });
    }
    if (!find("article.json", "research")) {
      issues.push({ key: "contract_article_json_missing", detail: "内容研究阶段未产出 research/article.json(文章机器可读契约:facts/feasibility/sections)——它是后续所有阶段的唯一事实源,落盘后再推进" });
    }
  }
  if (step === "plan-assets") {
    // B7 配套(2026-09-08 复审):图文版指令只要求 plan/plan.md 卡片规划 +
    // registry/material-candidates,无 script.json(逐句口播溯源对图文无下游消费者)——
    // 门禁必须同版豁免,否则图文 v2 按指令执行反被 400
    if (opts.workType !== "image-text" && !find("script.json", "assets")) {
      issues.push({ key: "contract_script_missing", detail: "分镜与素材探查阶段未产出 assets/script.json(逐句带 source_section 溯源 article 的脚本)——落盘后再推进" });
    }
    if (!find("registry.json", "plan-assets")) {
      issues.push({ key: "contract_registry_missing", detail: "分镜与素材探查阶段未产出 assets/registry.json(逐镜素材需求台账)——探查登记是引用存在性校验的依据,补齐后再推进" });
    }
    if (!find("material-candidates.md", "assets")) {
      issues.push({ key: "contract_candidates_missing", detail: "分镜与素材探查阶段未产出 assets/material-candidates.md(人读版台账,含查询组与缺口声明)——补齐后再推进" });
    }
  }
  return issues;
}

/**
 * 流水线 v2(批次2):内容研究阶段的文章契约机器校验——
 * ①article.json 可解析且关键字段齐全;②facts 核验态覆盖率达 depth 档阈值;
 * ③article.md 全文过 assertFactClaims(待核禁进口播);④字数与语速预算自洽。
 */
export function assertArticleContract(workDir: string, depth: "full" | "standard" | "quick" = "standard"): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const articleJsonPath = [join(workDir, "research", "article.json"), join(workDir, "article.json")].find(existsSync);
  const articleMdPath = [join(workDir, "research", "article.md"), join(workDir, "article.md")].find(existsSync);
  if (!articleJsonPath || !articleMdPath) return issues; // 文件缺失由 assertContractArtifacts 拦截,此处不重复

  interface ArticleFacts { text?: string; verify_status?: string; source_url?: string }
  interface ArticleJson {
    title?: string; wordCount?: number;
    speechBudget?: { maxChars?: number };
    facts?: ArticleFacts[];
    feasibility?: { verdict?: string; materialRisks?: unknown[]; notes?: string };
    sections?: unknown[];
  }
  let article: ArticleJson;
  try {
    article = JSON.parse(readFileSync(articleJsonPath, "utf-8")) as ArticleJson;
  } catch {
    return [{ key: "article_json_invalid", detail: "research/article.json 解析失败(损坏或非 JSON)——请修复后重新提交" }];
  }

  // ① 关键字段齐全
  const missing: string[] = [];
  if (!article.title?.trim()) missing.push("title");
  if (!(article.wordCount! > 0)) missing.push("wordCount");
  if (!article.speechBudget?.maxChars) missing.push("speechBudget.maxChars");
  if (!Array.isArray(article.facts)) missing.push("facts[]");
  if (!article.feasibility?.verdict) missing.push("feasibility.verdict");
  if (!Array.isArray(article.sections) || article.sections.length === 0) missing.push("sections[]");
  if (missing.length) {
    issues.push({ key: "article_fields_missing", detail: `article.json 关键字段缺失: ${missing.join(", ")}——按内容研究指令的 schema 补全` });
  }

  // ② facts 核验态覆盖率达 depth 档阈值(full=100% / standard≥80% / quick≥60%)
  const facts = article.facts ?? [];
  if (facts.length > 0) {
    const noUrl = facts.filter((f) => !f.source_url || !/^https?:\/\//.test(f.source_url));
    if (noUrl.length) {
      issues.push({ key: "article_facts_no_url", detail: `article.json 有 ${noUrl.length} 条 facts 缺有效 source_url——每条事实断言必须附可访问来源` });
    }
    const verified = facts.filter((f) => f.verify_status === "已核验").length;
    const ratio = verified / facts.length;
    const threshold = depth === "full" ? 1 : depth === "quick" ? 0.6 : 0.8;
    if (ratio < threshold) {
      issues.push({ key: "article_facts_unverified", detail: `事实核验覆盖率不足:已核验 ${verified}/${facts.length}(${(ratio * 100).toFixed(0)}%)< ${depth} 档要求 ${threshold * 100}%——逐项联网核查并附来源 URL` });
    }
  }

  // ③ 文章全文过事实断言检查(待核禁进口播;画面披露+"以官方发布为准"豁免)
  if (articleMdPath) {
    issues.push(...assertFactClaims(readFileSync(articleMdPath, "utf-8")));
  }

  // ④ 字数与语速预算自洽
  if (article.wordCount! > 0 && article.speechBudget?.maxChars) {
    if (article.wordCount! > article.speechBudget.maxChars * 1.2) {
      issues.push({ key: "article_budget_mismatch", detail: `文章字数 ${article.wordCount} 超出口播预算 ${article.speechBudget.maxChars} 字(×1.2 容差)——精简文章或调大目标时长` });
    }
  }
  return issues;
}

/** D3(2026-09 大工程):图文卡片 vision 核验——抽封面卡走视觉模型判 版式/文字溢出/配色。
 *  仅补 quality-gate 现有"数量≥2/非空白"检查的盲区。vision 不可用/超时降级跳过(不阻断)，
 *  因 D3 是提质项——基础门禁(卡片数/封面/空白)仍由 assertImageTextDeliverables 保证。 */
export async function assertImageTextVision(cardsDir: string, config: Config): Promise<DeliverableIssue[]> {
  const issues: DeliverableIssue[] = [];
  let cards: string[] = [];
  try {
    cards = readdirSync(cardsDir).filter((f) => /\.png$/i.test(f));
  } catch { return issues; }
  if (cards.length === 0) return issues;

  const cover = cards.find((f) => /cover/i.test(f)) ?? cards[0];
  const coverPath = join(cardsDir, cover);
  try {
    const { chatVisionJson } = await import("../llm/vision-json.js");
    const r = await chatVisionJson<{ problems?: string[]; verdict?: string }>(
      config,
      [coverPath],
      "你是图文卡片质检员。检查这张卡片：①文字是否溢出卡片边界或被裁切；②版式是否错乱（元素重叠/对齐失衡）；③配色是否协调（文字与背景对比度足够、无刺眼撞色）。输出 JSON {\"problems\":[\"问题1\",...]}，无问题则 problems 为空数组。",
      { timeoutMs: 60_000 },
    );
    for (const p of r?.problems ?? []) {
      if (typeof p === "string" && p.trim()) issues.push({ key: "card_vision", detail: `卡片 ${cover} 版式问题：${p.trim()}` });
    }
  } catch (err) {
    // 方案定稿：vision 核验是硬性——不可用/超时即 fail（不静默降级）
    issues.push({ key: "card_vision_unavailable", detail: `图文卡 vision 核验失败：${err instanceof Error ? err.message : String(err)}——请在设置页「大模型直连」配置视觉模型后重试` });
  }
  return issues;
}

/** M3(方案定稿):模板-成片视觉 diff——绑定模板的作品,终检比对成片与模板预览的整体视觉。
 *  抽首/中/尾帧,缩放到 16x16 rawvideo,逐像素平均绝对差 >0.3 即 fail(配色/版式明显偏离模板身份)。
 *  机器确定性检查(零 LLM 成本);ffmpeg 不可用时放行(模板契约仍由 template_skin 检查兜底)。 */
export async function assertTemplateVisualDiff(videoPath: string, templatePreviewPath?: string): Promise<DeliverableIssue[]> {
  const issues: DeliverableIssue[] = [];
  if (!videoPath || !existsSync(videoPath)) return issues;
  // 模板预览缺失 → 不阻断(视觉 diff 是可选机器检查,模板契约已由 template_skin 兜底)
  if (!templatePreviewPath || !existsSync(templatePreviewPath)) return issues;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { probeMedia } = await import("../video/ffmpeg.js");
    const info = await probeMedia(videoPath);
    const dur = info.duration ?? 30;
    const times = [0.5, dur / 2, Math.max(0.5, dur - 0.5)];
    const frameSig = async (p: string, t: number): Promise<Buffer> => {
      try {
        // encoding:"buffer" 保证 rawvideo 二进制不被 utf8 解码损坏
        const { stdout } = await execFileAsync("ffmpeg", ["-ss", String(t), "-i", p, "-frames:v", "1", "-vf", "scale=16:16", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, encoding: "buffer" });
        return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      } catch { return Buffer.alloc(0); }
    };
    const diff = (a: Buffer, b: Buffer): number => {
      if (a.length !== b.length || a.length === 0) return 1;
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
      return (sum / a.length) / 255;
    };
    let total = 0, n = 0;
    for (const t of times) {
      const sa = await frameSig(videoPath, t);
      const sb = await frameSig(templatePreviewPath, t);
      if (sa.length && sb.length) { total += diff(sa, sb); n++; }
    }
    if (n === 0) {
      issues.push({ key: "template_visual_unavailable", detail: "模板视觉 diff 无法抽帧(成片或预览不可读)" });
      return issues;
    }
    const avg = total / n;
    if (avg > 0.3) {
      issues.push({ key: "template_visual_mismatch", detail: `成片与模板视觉差异 ${(avg * 100).toFixed(0)}% > 30% 阈值——模板视觉身份(配色/版式)未贯穿成片,请按模板约束调整` });
    }
  } catch (err) {
    console.warn("[quality-gate] 模板视觉 diff 失败(不阻断):", err instanceof Error ? err.message : err);
  }
  return issues;
}
