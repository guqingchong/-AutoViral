import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { dataDir, loadConfig } from "../config.js";
import * as voicesRepo from "../db/voices-repo.js";
import type { DbVoice } from "../db/types.js";
import { uploadVoiceCloneFile, cloneVoiceOnMiniMax } from "../providers/minimax-voice-clone.js";
import { synthesizeToFile } from "../providers/minimax-tts.js";

const execFileAsync = promisify(execFile);

export const VOICE_SAMPLE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_DEMO_TEXT = "你好，这是一段试听音频，用于预览这个音色的配音效果。";
const DIRECT_EXTS = new Set([".mp3", ".wav", ".m4a"]);
const CONVERT_EXTS = new Set([".webm", ".ogg", ".opus", ".mp4", ".aac"]);

export function voicesDir(id: string): string { return join(dataDir, "voices", id); }
export function builtinDemoDir(): string { return join(dataDir, "voices", "builtin-demos"); }
export function isValidVoiceId(id: string): boolean { return /^[a-zA-Z0-9_-]+$/.test(id); }

/**
 * MiniMax 外部 voice_id 校验：官方系统音色 ID 可能含空格/括号/尾随空格
 * （如 "Chinese (Mandarin)_LyricMan"、"Santa_Claus "），仅禁止路径危险字符。
 */
export function isSafeExternalVoiceId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 256
    && !id.includes("..") && !/[\/\\]/.test(id) && !/[\x00-\x1f]/.test(id);
}

/** 内置音色试听文件名：简单 ID 直用（保留既有缓存），含特殊字符的 ID 用 sha1 哈希（文件系统安全） */
export function builtinDemoFileName(voiceId: string): string {
  if (isValidVoiceId(voiceId)) return `${voiceId}.mp3`;
  return `${createHash("sha1").update(voiceId).digest("hex").slice(0, 16)}.mp3`;
}

function newId(): string { return `v_${randomBytes(8).toString("hex")}`; }
// MiniMax voice_id 规则：字母开头、8-256 字符、仅字母数字及 -_
function newMiniMaxVoiceId(): string { return `avc-${randomBytes(6).toString("hex")}`; }

async function getMinimaxCfg() {
  const config = await loadConfig();
  if (!config.minimax?.apiKey) throw new Error("MiniMax 未配置：缺少 minimax.apiKey");
  return { apiKey: config.minimax.apiKey, groupId: (config.minimax as any).groupId };
}

/** 浏览器录音等非直传格式 → 内置 ffmpeg 转 mp3 */
async function ensureMp3(buffer: Buffer, filename: string, workDir: string): Promise<Buffer> {
  const ext = extname(filename).toLowerCase();
  if (DIRECT_EXTS.has(ext)) return buffer;
  if (!CONVERT_EXTS.has(ext)) throw new Error(`不支持的音频格式：${ext || "未知"}（支持 mp3/wav/m4a，或 webm/ogg 录音自动转码）`);
  const src = join(workDir, `source${ext}`);
  const dst = join(workDir, "sample.mp3");
  await writeFile(src, buffer);
  await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-y", "-i", src, "-vn", "-acodec", "libmp3lame", "-q:a", "4", dst]);
  const { readFile } = await import("node:fs/promises");
  return readFile(dst);
}

export async function cloneVoiceFromUpload(name: string, buffer: Buffer, filename: string): Promise<DbVoice> {
  if (buffer.byteLength > VOICE_SAMPLE_MAX_BYTES) throw new Error("音频文件超过 20MB 上限");
  const now = new Date().toISOString();
  const voice: DbVoice = {
    id: newId(), name: name.trim() || "未命名声音", voice_id: newMiniMaxVoiceId(),
    type: "cloned", status: "cloning", metadata: {}, usage_count: 0,
    created_at: now, updated_at: now,
  };
  voicesRepo.createVoice(voice);
  try {
    const dir = voicesDir(voice.id);
    await mkdir(dir, { recursive: true });
    const mp3 = await ensureMp3(buffer, filename, dir);
    const samplePath = join(dir, "sample.mp3");
    await writeFile(samplePath, mp3);
    const cfg = await getMinimaxCfg();
    const fileId = await uploadVoiceCloneFile(cfg, mp3, "sample.mp3");
    await cloneVoiceOnMiniMax(cfg, fileId, voice.voice_id);
    return voicesRepo.updateVoice(voice.id, { status: "ready", source_file_path: samplePath })!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    voicesRepo.updateVoice(voice.id, { status: "failed", error: message });
    throw err;
  }
}

export async function generateVoiceDemo(id: string, text?: string): Promise<string> {
  const voice = voicesRepo.getVoice(id);
  if (!voice) throw new Error("音色不存在");
  if (voice.status !== "ready") throw new Error(`音色不可用（状态：${voice.status}）`);
  if (voice.demo_audio_path) {
    try { await access(voice.demo_audio_path); return voice.demo_audio_path; } catch { /* 文件丢失则重新生成 */ }
  }
  const cfg = await getMinimaxCfg();
  const outPath = join(voicesDir(id), "demo.mp3");
  await mkdir(voicesDir(id), { recursive: true });
  const result = await synthesizeToFile(cfg.apiKey, { text: text?.trim() || DEFAULT_DEMO_TEXT, voice: voice.voice_id, outPath });
  if (!result.success) throw new Error(result.error ?? "试听合成失败");
  voicesRepo.updateVoice(id, { demo_audio_path: outPath });
  return outPath;
}

export async function generateBuiltinDemo(voiceId: string, text?: string): Promise<string> {
  if (!isSafeExternalVoiceId(voiceId)) throw new Error("非法 voice_id");
  const outPath = join(builtinDemoDir(), builtinDemoFileName(voiceId));
  try { await access(outPath); return outPath; } catch { /* 未缓存 */ }
  const cfg = await getMinimaxCfg();
  await mkdir(builtinDemoDir(), { recursive: true });
  const result = await synthesizeToFile(cfg.apiKey, { text: text?.trim() || DEFAULT_DEMO_TEXT, voice: voiceId, outPath });
  if (!result.success) throw new Error(result.error ?? "试听合成失败");
  return outPath;
}

export async function favoriteBuiltinVoice(voiceId: string, name: string, metadata: Record<string, unknown> = {}): Promise<DbVoice> {
  const existing = voicesRepo.getVoiceByVoiceId(voiceId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const voice: DbVoice = {
    id: newId(), name, voice_id: voiceId, type: "builtin_fav", status: "ready",
    metadata, usage_count: 0, created_at: now, updated_at: now,
  };
  return voicesRepo.createVoice(voice);
}

export async function deleteVoiceWithFiles(id: string): Promise<boolean> {
  if (!voicesRepo.getVoice(id)) return false;
  await rm(voicesDir(id), { recursive: true, force: true });
  return voicesRepo.deleteVoice(id);
}
