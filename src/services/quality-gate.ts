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

  // 定位分镜文档:根目录 plan.md 优先,其次 assets/plan-storyboard.md
  const planCandidates = [join(workDir, "plan.md"), join(workDir, "assets", "plan-storyboard.md")];
  const planPath = planCandidates.find((p) => existsSync(p));
  if (!planPath) {
    return [{ key: "plan_doc", detail: "分镜文档缺失(plan.md 或 assets/plan-storyboard.md 均不存在)" }];
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
 */
export function assertAssemblyDeliverables(workDir: string): DeliverableIssue[] {
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

  // ③ 质检报告时效
  const reportFile = files.find((f) => f === "quality-report.json");
  if (!reportFile) {
    issues.push({ key: "quality_report", detail: "output/quality-report.json 缺失(成片未过质量门禁)" });
  } else if (finalVideo) {
    try {
      const report = JSON.parse(readFileSync(join(outDir, reportFile), "utf-8")) as { videoPath?: string };
      if (!report.videoPath || basename(report.videoPath) !== finalVideo) {
        issues.push({ key: "quality_report", detail: `quality-report.json 的 videoPath(${report.videoPath ?? "空"})不指向当前成片 ${finalVideo}——QC 跑在了旧文件上` });
      } else if (statSync(join(outDir, reportFile)).mtimeMs < statSync(join(outDir, finalVideo)).mtimeMs) {
        issues.push({ key: "quality_report", detail: "quality-report.json 早于成片最后修改时间——成片重渲染后未重跑 QC" });
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
