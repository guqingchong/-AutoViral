/**
 * 优秀作品模板克隆(2026-08-13 模板库改造 功能 a,二期)。
 *
 * 用户粘贴优秀作品链接,克隆其视觉模板入库:
 *   - 小红书图文笔记:Playwright 持久会话打开 → 抓笔记图片 → claude CLI
 *     视觉分析(Read 本地图片)→ cover/content 两条 LayoutSpec → image-text 模板
 *   - 抖音视频:yt-dlp 下载 → ffmpeg 抽帧 → claude 视觉分析 →
 *     Timeline layers(视频层用 {{clip_N}} 变量占位)→ video 模板
 *
 * 产出 status=draft,用户在模板库预览确认后启用;
 * 可继续用「再加工」(template-refine)打磨 —— 克隆/加工/预览形成闭环。
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { createTemplate, deleteTemplate } from "../db/templates-repo.js";
import { validateTemplate } from "../video/schema.js";
import { normalizeLayoutSpec, type LayoutSpec } from "./image-text-template-generator.js";
import { resolveClaudeCommand } from "../ws-bridge.js";
import { getContext } from "./platform-adapters/playwright-helper.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CloneStage = "download" | "frames" | "analyze" | "build";

export interface CloneResult {
  templateId: string;
  name: string;
  kind: "video" | "image-text";
}

export interface CloneOptions {
  url: string;
  name?: string;
  /** 用户补充说明,如"我喜欢它的配色和节奏" */
  hint?: string;
  /** 克隆完成后删除源文件(仅上传的临时副本置 true,用户本地文件绝不删除) */
  cleanupSource?: boolean;
  onStage?: (stage: CloneStage) => void;
}

/** 视觉分析 runner:spawn claude CLI,只允许 Read(读本地抽帧图片) */
function runVisionCli(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = resolveClaudeCommand();
    const hardenedPrompt =
      prompt +
      "\n\n## 输出纪律(必须严格遵守)\n" +
      "- 用 Read 工具逐张查看给你的图片文件,然后输出分析结果 JSON。\n" +
      "- 禁止创建、写入或保存任何文件。\n" +
      "- 最终回复只包含 JSON,不要用 markdown 代码围栏,不要附加解释。\n";
    const proc = spawn(cli, [
      "-p", hardenedPrompt,
      "--output-format", "json",
      "--dangerously-skip-permissions",
      "--allowedTools", "Read",
      "--model", "sonnet",
    ], {
      cwd: process.env["HOME"] ?? process.cwd(),
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" },
      windowsHide: true,
    });
    try { proc.stdin?.end(); } catch { /* ignore */ }

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error("视觉分析超时"));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Claude CLI exited with code ${code}${stderr ? ": " + stderr.slice(0, 500) : ""}`));
      }
      try {
        const envelope = JSON.parse(stdout);
        resolve((envelope.result ?? "").toString());
      } catch {
        resolve(stdout);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1)) as T;
  } catch {
    return null;
  }
}

function deleteTemplateQuiet(id: string): void {
  try { deleteTemplate(id); } catch { /* 清理失败不阻断错误上报 */ }
}

type CloneTarget =
  | { platform: "local"; kind: "video" }
  | { platform: "xiaohongshu"; kind: "image-text" }
  | { platform: "douyin"; kind: "video" };

/**
 * 从用户输入提取有效 URL。
 * 抖音/小红书「复制链接」出来的是整段分享口令(标题+话题+口令码+链接+引导语),
 * 直接当 URL 用必然失败——先抽出其中的 http(s) 链接(2026-08-13 用户实测踩坑)。
 */
export function extractUrlFromInput(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//.test(trimmed)) return trimmed.split(/\s/)[0];
  const m = trimmed.match(/https?:\/\/[^\s,，。;；""''】」》）)\]]+/);
  return m ? m[0] : trimmed;
}

/** URL/路径 → 平台与内容形态。小红书视频笔记二期 B 暂不支持;本地视频文件直接走抽帧 */
export function routeCloneUrl(rawInput: string): CloneTarget {
  const url = extractUrlFromInput(rawInput);
  // 本地视频文件(微信视频号等网页版不放流平台,用户自行保存视频后克隆)
  if (/\.(mp4|mov|webm|mkv)$/i.test(url) && !/^https?:\/\//.test(url)) {
    return { platform: "local", kind: "video" };
  }
  if (/weixin\.qq\.com\/sph|channels\.weixin\.qq\.com/.test(url)) {
    throw new Error("微信视频号网页版不提供视频流(仅封面+扫码观看),作者关闭下载时微信内也无法直接保存。可行办法:① 用 res-downloader(开源免费)开启代理嗅探后,在 PC 微信播放该视频即可拦截下载;② 手机/电脑录屏。拿到 mp4 后点输入框旁的「上传视频克隆」直接上传,或把文件路径粘贴过来");
  }
  if (/xiaohongshu\.com|xhslink\.com/.test(url)) return { platform: "xiaohongshu", kind: "image-text" };
  if (/douyin\.com|iesdouyin\.com/.test(url)) return { platform: "douyin", kind: "video" };
  throw new Error("暂不支持该平台:目前支持小红书图文笔记、抖音视频链接,或本地视频文件路径");
}

// ── 小红书图文克隆 ─────────────────────────────────────────────────────────

/** 打开笔记页抓内容图 URL 列表(swiper 图集) */
async function fetchNoteImages(url: string, workDir: string): Promise<string[]> {
  const ctx = await getContext("xiaohongshu");
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // 等图集加载;无图集的页面(视频笔记/被拦截)走降级
    await page.waitForSelector("img", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const imgUrls: string[] = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      return imgs
        .map((i) => i.src)
        .filter((s) => /sns-webpic|xhscdn|ci\.xiaohongshu\.com/.test(s) && !/avatar|icon|emoji/.test(s));
    });

    const paths: string[] = [];
    if (imgUrls.length > 0) {
      // 去重(同图多个尺寸变体,取原图参数)
      const uniq = [...new Set(imgUrls.map((u) => u.split("?")[0]))].slice(0, 6);
      for (const [i, u] of uniq.entries()) {
        try {
          const res = await fetch(u);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 10_000) continue; // 太小大概是图标
          const p = join(workDir, `note-${i}.jpg`);
          await writeFile(p, buf);
          paths.push(p);
        } catch { /* 单图失败跳过 */ }
      }
    }

    // 降级:一张没抓到则整页截图
    if (paths.length === 0) {
      const shot = join(workDir, "note-page.png");
      await page.screenshot({ path: shot, fullPage: false });
      paths.push(shot);
    }
    return paths;
  } finally {
    await page.close();
  }
}

interface CloneLayoutResponse {
  name?: string;
  cover?: Record<string, unknown>;
  contentPage?: Record<string, unknown>;
}

async function analyzeImageText(imagePaths: string[], hint: string | undefined): Promise<CloneLayoutResponse> {
  const prompt = [
    "你是顶级图文内容视觉设计师。以下是同一篇优秀小红书图文笔记的页面截图/图片。",
    "分析它的视觉版式,蒸馏成可复用的图文模板。",
    "",
    "## 图片文件(用 Read 工具逐张查看)",
    ...imagePaths.map((p) => `- ${p.replace(/\\/g, "/")}`),
    "",
    hint ? `## 用户补充(用户特别想克隆的点)\n${hint}` : "",
    "",
    "## 输出要求",
    "输出 JSON:{\"name\":\"模板名称(概括风格,如 墨绿杂志卡片)\",\"cover\":{...},\"contentPage\":{...}}",
    "cover 与 contentPage 均为 LayoutSpec:",
    "- layout: 蛇形命名版式结构,如 big_title_center / magazine_left / top_block / card_stack / split_screen / fullscreen_caption(也可自创更贴切的蛇形名)",
    "- font: 最接近的常见中文字体(Noto Sans SC / 思源黑体 / 思源宋体 / 站酷高端黑 等)",
    "- fontSize: 主标题字号(封面 72-120,内容页 48-72)",
    "- colorScheme: {background, primary, text, accent} 全部 #RRGGBB 六位实色,从图片中吸取",
    "- decorations: 0-3 个,从 accent_bar(装饰条)/serial_number(序号)/divider(分隔线)/texture(底纹)/corner_marks(角标) 中选",
    "- 封面版式抓第一眼冲击的结构;内容页抓正文排版结构",
  ].filter(Boolean).join("\n");

  const text = await runVisionCli(prompt, 480_000);
  const parsed = extractJson<CloneLayoutResponse>(text);
  if (!parsed?.cover || !parsed?.contentPage) {
    throw new Error("视觉分析产出无法解析为版式方案");
  }
  return parsed;
}

async function cloneFromXiaohongshu(opts: CloneOptions, workDir: string): Promise<CloneResult> {
  opts.onStage?.("download");
  const imagePaths = await fetchNoteImages(opts.url, workDir);

  opts.onStage?.("analyze");
  const spec = await analyzeImageText(imagePaths, opts.hint);

  opts.onStage?.("build");
  const cover = normalizeLayoutSpec(spec.cover);
  const content = normalizeLayoutSpec(spec.contentPage);
  if (!cover || !content) throw new Error("版式方案归一化失败");

  const id = `tpl_it_${randomUUID().slice(0, 8)}`;
  const template = createTemplate({
    id,
    name: opts.name ?? spec.name ?? "克隆模板",
    content_form: "image-text",
    canvas: { width: 1080, height: 1440, fps: 30, backgroundColor: cover.colorScheme.background ?? "#FFFFFF" },
    variables: [],
    layers: [
      { id: "cover", type: "image-text-layout", page: "cover", ...cover },
      { id: "content-page", type: "image-text-layout", page: "content", ...content },
    ],
    audio: [],
    transitions: [],
    status: "draft",
    kind: "image-text",
  });
  return { templateId: template.id, name: template.name, kind: "image-text" };
}

// ── 抖音视频克隆 ───────────────────────────────────────────────────────────

/** 抖音网页版抓视频流下载(yt-dlp 对抖音反爬失效时的兜底,2026-08-13 实测)。
 *  抖音网页版走 DASH 音画分离:必须收集多个流,下载后用 ffprobe 选出含视频轨的
 *  (只凭 content-type 会抓到纯音频轨——实测踩坑)。 */
async function downloadDouyinViaPlaywright(url: string, workDir: string): Promise<string> {
  const ctx = await getContext("douyin");
  const page = await ctx.newPage();
  try {
    const mediaUrls: string[] = [];
    page.on("response", (res) => {
      const u = res.url();
      const ct = res.headers()["content-type"] ?? "";
      if ((ct.includes("video") || ct.includes("audio")) && /douyinvod\.com/.test(u) && !mediaUrls.includes(u)) {
        mediaUrls.push(u);
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // 等至少 2 条流(视频轨+音频轨)或超时
    const deadline = Date.now() + 25_000;
    while (mediaUrls.length < 2 && Date.now() < deadline) {
      await page.waitForTimeout(800);
    }
    if (mediaUrls.length === 0) throw new Error("未抓到视频流(页面可能要求登录或滑块验证)");

    // 页面内 fetch 逐条下载(带会话 cookie/referer),大文件分块转 base64
    const payloads = await page.evaluate(async (urls) => {
      const out: string[] = [];
      for (const u of urls.slice(0, 4)) {
        try {
          const res = await fetch(u);
          if (!res.ok) continue;
          const buf = new Uint8Array(await res.arrayBuffer());
          let bin = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < buf.length; i += CHUNK) {
            bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
          }
          out.push(btoa(bin));
        } catch { /* 单条失败跳过 */ }
      }
      return out;
    }, mediaUrls);

    // 逐条 ffprobe,选第一条含视频流的
    for (const [i, b64] of payloads.entries()) {
      const p = join(workDir, `stream-${i}.mp4`);
      await writeFile(p, Buffer.from(b64, "base64"));
      try {
        const probe = await execFileAsync("ffprobe", [
          "-v", "error", "-select_streams", "v:0",
          "-show_entries", "stream=codec_type", "-of", "csv=p=0", p,
        ]);
        if (probe.stdout.includes("video")) {
          // 直接改名复用,避免 33MB 级视频再写一份副本
          const out = join(workDir, "source.mp4");
          await rename(p, out);
          return out;
        }
      } catch { /* 无法探测的跳过 */ }
    }
    throw new Error("抓到的流都不含视频轨(DASH 音画分离未捕获到视频轨)");
  } finally {
    await page.close();
  }
}

async function downloadDouyinVideo(url: string, workDir: string): Promise<string> {
  const out = join(workDir, "source.mp4");
  try {
    await execFileAsync("yt-dlp", [
      "-f", "bestvideo[height<=1080]+bestaudio/best",
      "--merge-output-format", "mp4",
      "-o", out, url,
    ], { timeout: 180_000 });
    if (existsSync(out)) return out;
  } catch {
    // yt-dlp 对抖音的反爬时好时坏,落 Playwright 抓流
  }
  return downloadDouyinViaPlaywright(url, workDir);
}

async function extractFrames(videoPath: string, workDir: string): Promise<string[]> {
  const probe = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath,
  ]);
  const duration = parseFloat(probe.stdout.trim()) || 10;
  const times = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((r) => Math.min(duration - 0.1, duration * r));
  const paths: string[] = [];
  for (const [i, t] of times.entries()) {
    const p = join(workDir, `frame-${i}.png`);
    await execFileAsync("ffmpeg", ["-ss", t.toFixed(2), "-i", videoPath, "-frames:v", "1", "-y", p], { timeout: 30_000 });
    if (existsSync(p)) paths.push(p);
  }
  if (paths.length === 0) throw new Error("视频抽帧失败");
  return paths;
}

interface CloneVideoResponse {
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number; backgroundColor?: string };
  variables?: Array<{ name: string; type: string; default?: string | number; label?: string }>;
  layers?: Record<string, unknown>[];
  transitions?: Record<string, unknown>[];
}

async function analyzeVideoFrames(framePaths: string[], durationSec: number, hint: string | undefined): Promise<CloneVideoResponse> {
  const prompt = [
    "你是顶级短视频视觉设计师。以下是从同一条优秀短视频均匀抽取的帧(按时序排列)。",
    `视频总时长约 ${durationSec.toFixed(1)} 秒。分析它的视觉呈现,蒸馏成可复用的视频模板。`,
    "",
    "## 帧图片(用 Read 工具逐张查看)",
    ...framePaths.map((p) => `- ${p.replace(/\\/g, "/")}`),
    "",
    hint ? `## 用户补充(用户特别想克隆的点)\n${hint}` : "",
    "",
    "## 输出要求",
    "输出 JSON:{\"name\":\"模板名称\",\"canvas\":{\"width\":1080,\"height\":1920,\"fps\":30,\"backgroundColor\":\"#0a0a0a\"},\"variables\":[...],\"layers\":[...],\"transitions\":[...]}",
    "- layers 支持的 type: video(主素材)/image(图片)/text(文字)/shape(色块)",
    "- 主素材层:source 写 \"{{clip_1}}\"(变量占位),variables 里声明 {name:'clip_1',type:'video',label:'主素材'}",
    "- text 层:{id,type:'text',content:'{{title}}' 或固定文案,start,duration,position(像素{x,y}或center/top/bottom),fontSize,color,align,stroke?};文案槽位在 variables 声明",
    "- shape 层:{id,type:'shape',shape:'rect',fill:'#RRGGBB',start,duration,position:{x,y},size:{width,height}}",
    "- 空心边框/描边(如围绕画面的细白框):shape 层用 stroke 表达——fill 写 \"transparent\",加 stroke:{width:边框粗细px,color:'#RRGGBB'};禁止用实心矩形垫底来模拟边框(会把画面盖掉)。实心填充+描边可同时给 fill 和 stroke",
    "- 像素估算纪律:以画布尺寸为参照,仔细量取边框粗细(通常 2-8px)、四边留白、元素间距,不要凭感觉取整;同一元素在多帧中出现时交叉验证坐标",
    "- 圆角矩形系统不支持,用直角矩形近似即可",
    "- 每层必须有 start(秒)与 duration(秒);按帧出现时序推断文字层的时间窗",
    "- animations 可选:fadein/fadeout/slidein/slideout,如 {type:'fadein',duration:0.5}",
    "- transitions 数组:层间转场 [{type:'fade'|'slide'|'wipe',duration:0.5}]",
    "- 只克隆视觉结构(版式/配色/字体层级/转场节奏),不克隆具体内容文案本身——文案要参数化为变量",
  ].filter(Boolean).join("\n");

  const text = await runVisionCli(prompt, 480_000);
  const parsed = extractJson<CloneVideoResponse>(text);
  if (!parsed?.layers || !Array.isArray(parsed.layers) || parsed.layers.length === 0) {
    throw new Error("视觉分析产出无法解析为图层结构");
  }
  return parsed;
}

async function cloneFromVideo(opts: CloneOptions, workDir: string, videoPath: string): Promise<CloneResult> {
  opts.onStage?.("frames");
  const probe = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath,
  ]);
  const duration = parseFloat(probe.stdout.trim()) || 10;
  const framePaths = await extractFrames(videoPath, workDir);

  opts.onStage?.("analyze");
  const spec = await analyzeVideoFrames(framePaths, duration, opts.hint);

  opts.onStage?.("build");
  const id = `tpl_${randomUUID().slice(0, 8)}`;
  // validateTemplate 读平铺的 layers/audio/transitions(不是 timeline 嵌套)
  const validated = validateTemplate({
    id,
    name: opts.name ?? spec.name ?? "克隆模板",
    canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0a0a0a", ...spec.canvas },
    variables: spec.variables ?? [],
    layers: spec.layers ?? [],
    audio: [],
    transitions: spec.transitions ?? [],
  });
  const template = createTemplate({
    id,
    name: validated.name,
    canvas: validated.canvas,
    variables: validated.variables,
    layers: validated.timeline.layers as unknown as Record<string, unknown>[],
    audio: validated.timeline.audio as unknown as Record<string, unknown>[],
    subtitles: validated.timeline.subtitles as unknown as Record<string, unknown> | undefined,
    transitions: (validated.timeline.transitions ?? []) as unknown as Record<string, unknown>[],
    status: "draft",
    kind: "video",
  });
  // 防线:空 layers 模板没有使用价值,直接报错让用户重试(2026-08-13 踩坑:
  // validateTemplate 输入结构错误时 layers 静默变空)
  if (template.layers.length === 0) {
    deleteTemplateQuiet(id);
    throw new Error("克隆失败:产出的模板没有任何图层(视觉分析结果为空),请重试或换个链接");
  }
  return { templateId: template.id, name: template.name, kind: "video" };
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

export async function cloneTemplate(opts: CloneOptions): Promise<CloneResult> {
  const cleanUrl = extractUrlFromInput(opts.url);
  const target = routeCloneUrl(cleanUrl);
  const cleanOpts = { ...opts, url: cleanUrl };
  const workDir = join(dataDir, "templates", `clone-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  try {
    if (target.platform === "xiaohongshu") return await cloneFromXiaohongshu(cleanOpts, workDir);
    if (target.platform === "douyin") {
      cleanOpts.onStage?.("download");
      const videoPath = await downloadDouyinVideo(cleanUrl, workDir);
      return await cloneFromVideo(cleanOpts, workDir, videoPath);
    }
    // 本地视频文件:跳过下载直接抽帧
    if (!existsSync(cleanUrl)) throw new Error(`本地视频文件不存在: ${cleanUrl}`);
    return await cloneFromVideo(cleanOpts, workDir, cleanUrl);
  } finally {
    // 下载的视频流/抽帧只服务于本次分析,完成后即清理(2026-08-13:
    // 一次抖音克隆残留 80MB,source.mp4 与 stream-N.mp4 内容重复)
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* 清理失败不阻断结果 */ });
    if (opts.cleanupSource) {
      await rm(cleanUrl, { force: true }).catch(() => { /* 清理失败无碍 */ });
    }
  }
}
