/**
 * 字幕生成服务(2026-09-11,字幕截断复盘)。
 *
 * 来源:w_20260910_1758_479 成片字幕每 ~7 字硬切,"2025" 被腰斩成 "20|25"、
 * "国有" 跨行——autoviral 没有字幕生成服务,agent 每作品手搓 karaoke ass,
 * 断行只看字数不看语义。本服务收口:
 *   ① 语义断行:数字/英文词是原子 token 永不拆开;标点跟随前字(行首不出现标点);
 *      贪心装填 ≤15 字/可视行(与门禁 MAX_SUBTITLE_LINE_CHARS 同口径)
 *   ② karaoke \kf 按字数均布条目时长(与既有成片观感一致)
 *   ③ 空文本(无旁白镜头)不产生字幕条——占位文字由门禁拦截,服务直接跳过
 *
 * 入口:POST /api/assets/subtitles { workId, lines:[{text,start,end}], out? }
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataDir } from "../config.js";
import { MAX_SUBTITLE_LINE_CHARS, measureAssSubtitles } from "./quality-gate.js";

export interface SubtitleLine {
  text: string;
  /** 秒 */
  start: number;
  end: number;
}

/** 断行用原子 token:数字串(含小数/%)、英文单词为整体;标点跟随前 token */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /[0-9]+(?:\.[0-9]+)?%?|[A-Za-z]+(?:['’-][A-Za-z]+)*|./gs;
  for (const m of text.matchAll(re)) tokens.push(m[0]);
  // 闭标点并入前一 token(行首不出现标点);开标点(引号/括号)并入后一 token
  const merged: string[] = [];
  for (const t of tokens) {
    if (/^[，。、；：？！…·％)）\]】》”’]$/.test(t) && merged.length) {
      merged[merged.length - 1] += t;
    } else if (/^[(（\[【《“‘]$/.test(t) && merged.length) {
      merged[merged.length - 1] += t; // 开标点也尽量贴前token尾部,避免孤悬行首
    } else {
      merged.push(t);
    }
  }
  return merged;
}

/** 语义断行:贪心装填,单可视行 ≤ maxChars;数字/英文词原子不拆(超长单词兜底硬切) */
export function wrapSemantic(text: string, maxChars = MAX_SUBTITLE_LINE_CHARS): string[] {
  const tokens = tokenize(text.replace(/\s+/g, ""));
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    const tLen = [...t].length;
    if (cur && [...cur].length + tLen > maxChars) {
      lines.push(cur);
      cur = "";
    }
    if (tLen > maxChars) {
      // 超长原子 token(罕见长数字/长单词):兜底硬切,宁切不断行规
      let rest = t;
      while ([...rest].length > maxChars) {
        const cut = [...rest].slice(0, maxChars).join("");
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(cut);
        rest = [...rest].slice(maxChars).join("");
      }
      cur = rest;
      continue;
    }
    cur += t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const toAssTime = (s: number): string => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/**
 * 生成 karaoke ass:[Script Info]/[V4+ Styles]/[Events] 齐全;
 * 每条目 \N 连接可视行,\kf 按字符均布(单位:厘秒)。
 */
export function buildAss(lines: SubtitleLine[], opts: { playResX?: number; playResY?: number; style?: string } = {}): string {
  const W = opts.playResX ?? 1920;
  const H = opts.playResY ?? 1080;
  const style = opts.style ?? "FontName=Noto Sans CJK SC,FontSize=48,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=86";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, FontName, FontSize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Alignment, MarginV
Style: Default,${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body: string[] = [];
  for (const l of lines) {
    const text = (l.text ?? "").trim();
    if (!text) continue; // 无旁白镜头:空文本 = 无字幕条(结构化表达,占位文字由门禁拦截)
    const durCs = Math.max(1, Math.round((l.end - l.start) * 100));
    const visual = wrapSemantic(text);
    const chars = [...text.replace(/\s/g, "")];
    const per = Math.max(1, Math.floor(durCs / Math.max(1, chars.length)));
    // karaoke:\kf 按字符均布,首字符吃余量(与既有成片观感一致);按可视行边界插 \N
    let charIdx = 0;
    const rendered = visual.map((vl) => {
      const vchars = [...vl.replace(/\s/g, "")];
      return vchars.map((ch) => {
        const k = charIdx === 0 ? durCs - per * (chars.length - 1) : per;
        charIdx += 1;
        return `{\\kf${k}}${ch}`;
      }).join("");
    });
    body.push(`Dialogue: 0,${toAssTime(l.start)},${toAssTime(l.end)},Default,,0,0,0,,${rendered.join("\\N")}`);
  }
  return header + body.join("\n") + "\n";
}

/** 端点入口:生成并落盘,返回测量结果(违规随响应带回,agent 可即时自查) */
export async function generateSubtitles(workId: string, lines: SubtitleLine[], out = "output/final.ass"): Promise<{ path: string; entries: number; maxCps: number; violations: string[] }> {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("lines 为空——至少一条 {text,start,end};无旁白镜头传空 text 或直接省略该条");
  for (const [i, l] of lines.entries()) {
    if (!(l.end > l.start)) throw new Error(`第 ${i + 1} 条 end(${l.end}) 必须大于 start(${l.start})`);
  }
  const root = resolve(dataDir);
  const workDir = resolve(join(dataDir, "works", workId));
  if (workDir !== root && !workDir.startsWith(root + sep)) throw new Error("workId 非法");
  const outPath = resolve(workDir, out);
  if (outPath !== workDir && !outPath.startsWith(workDir + sep)) throw new Error(`out 路径越界:${out}`);
  const ass = buildAss(lines);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, ass, "utf-8");
  const m = measureAssSubtitles(ass);
  return { path: outPath, entries: m.entries, maxCps: Number(m.maxCps.toFixed(2)), violations: m.violations };
}
