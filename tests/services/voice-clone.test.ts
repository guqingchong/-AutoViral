import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/providers/minimax-voice-clone.js", () => ({
  uploadVoiceCloneFile: vi.fn(),
  cloneVoiceOnMiniMax: vi.fn(),
  listSystemVoices: vi.fn(),
}));
vi.mock("../../src/providers/minimax-tts.js", () => ({
  MiniMaxTTSProvider: vi.fn(),
  synthesizeToFile: vi.fn(),
}));

import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const cfg = { minimax: { apiKey: "k" } } as any;

describe("voice-clone service", () => {
  let dir: string;
  let svc: typeof import("../../src/services/voice-clone.js");
  let cloneClient: any;
  let tts: any;
  let voicesRepo: typeof import("../../src/db/voices-repo.js");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-vc-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    const configModule = await import("../../src/config.js");
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(cfg);
    cloneClient = await import("../../src/providers/minimax-voice-clone.js");
    tts = await import("../../src/providers/minimax-tts.js");
    voicesRepo = await import("../../src/db/voices-repo.js");
    svc = await import("../../src/services/voice-clone.js");
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  it("克隆成功：样本落盘、调用两步 API、状态 ready", async () => {
    cloneClient.uploadVoiceCloneFile.mockResolvedValue(42);
    cloneClient.cloneVoiceOnMiniMax.mockResolvedValue(undefined);
    const voice = await svc.cloneVoiceFromUpload("我的声音", Buffer.from("mp3-bytes"), "sample.mp3");
    expect(voice.status).toBe("ready");
    expect(voice.type).toBe("cloned");
    expect(cloneClient.cloneVoiceOnMiniMax).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "k" }), 42, voice.voice_id,
    );
    await access(voice.source_file_path!);
  });

  it("克隆失败：状态 failed + error，且抛出错误", async () => {
    cloneClient.uploadVoiceCloneFile.mockResolvedValue(42);
    cloneClient.cloneVoiceOnMiniMax.mockRejectedValue(new Error("audio too short"));
    await expect(
      svc.cloneVoiceFromUpload("坏样本", Buffer.from("x"), "sample.mp3"),
    ).rejects.toThrow("audio too short");
    const failed = voicesRepo.listVoices().find((v) => v.name === "坏样本");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("audio too short");
  });

  it("非 mp3/wav/m4a 且非可转格式的文件直接拒绝", async () => {
    await expect(
      svc.cloneVoiceFromUpload("文本", Buffer.from("hello"), "notes.txt"),
    ).rejects.toThrow("不支持的音频格式");
  });

  it("试听：首次合成落盘并记录 demo_audio_path，第二次复用不再合成", async () => {
    cloneClient.uploadVoiceCloneFile.mockResolvedValue(1);
    cloneClient.cloneVoiceOnMiniMax.mockResolvedValue(undefined);
    const voice = await svc.cloneVoiceFromUpload("试听音色", Buffer.from("x"), "a.mp3");
    tts.synthesizeToFile.mockImplementation(async (_k: string, opts: any) => {
      await writeFile(opts.outPath, Buffer.from("demo"));
      return { success: true, assetPath: opts.outPath };
    });
    const p1 = await svc.generateVoiceDemo(voice.id);
    const p2 = await svc.generateVoiceDemo(voice.id);
    expect(p1).toBe(p2);
    expect(tts.synthesizeToFile).toHaveBeenCalledTimes(1);
    expect(voicesRepo.getVoice(voice.id)?.demo_audio_path).toBe(p1);
  });

  it("内置音色试听按 voice_id 缓存，不落库", async () => {
    tts.synthesizeToFile.mockImplementation(async (_k: string, opts: any) => {
      await writeFile(opts.outPath, Buffer.from("demo"));
      return { success: true, assetPath: opts.outPath };
    });
    const p = await svc.generateBuiltinDemo("male-qn-qingse");
    expect(p).toContain("builtin-demos");
    expect(voicesRepo.listVoices()).toHaveLength(0);
  });

  it("内置音色试听支持含空格/括号的 MiniMax voice_id（哈希文件名缓存）", async () => {
    tts.synthesizeToFile.mockImplementation(async (_k: string, opts: any) => {
      await writeFile(opts.outPath, Buffer.from("demo"));
      return { success: true, assetPath: opts.outPath };
    });
    const voiceId = "Chinese (Mandarin)_LyricMan";
    const p1 = await svc.generateBuiltinDemo(voiceId);
    expect(p1).toContain("builtin-demos");
    expect(basename(p1)).toMatch(/^[a-zA-Z0-9_-]+\.mp3$/);
    await access(p1);
    // 第二次调用命中缓存，不再合成
    const p2 = await svc.generateBuiltinDemo(voiceId);
    expect(p2).toBe(p1);
    expect(tts.synthesizeToFile).toHaveBeenCalledTimes(1);
    // 带尾随空格的 ID（MiniMax 真实数据，如 "Santa_Claus "）同样可用
    const p3 = await svc.generateBuiltinDemo("Santa_Claus ");
    expect(basename(p3)).toMatch(/^[a-zA-Z0-9_-]+\.mp3$/);
  });

  it("内置音色试听拒绝路径穿越 voice_id", async () => {
    await expect(svc.generateBuiltinDemo("../evil")).rejects.toThrow("非法 voice_id");
    await expect(svc.generateBuiltinDemo("a/b")).rejects.toThrow("非法 voice_id");
    await expect(svc.generateBuiltinDemo("a\\b")).rejects.toThrow("非法 voice_id");
  });

  it("收藏内置音色落库为 builtin_fav/ready，重复收藏返回已有", async () => {
    const v1 = await svc.favoriteBuiltinVoice("presenter_male", "新闻男声");
    const v2 = await svc.favoriteBuiltinVoice("presenter_male", "新闻男声");
    expect(v1.id).toBe(v2.id);
    expect(v1.type).toBe("builtin_fav");
    expect(v1.status).toBe("ready");
    expect(voicesRepo.listVoices()).toHaveLength(1);
  });

  it("删除音色同时删除目录", async () => {
    cloneClient.uploadVoiceCloneFile.mockResolvedValue(1);
    cloneClient.cloneVoiceOnMiniMax.mockResolvedValue(undefined);
    const voice = await svc.cloneVoiceFromUpload("待删", Buffer.from("x"), "a.mp3");
    expect(await svc.deleteVoiceWithFiles(voice.id)).toBe(true);
    expect(voicesRepo.getVoice(voice.id)).toBeUndefined();
  });
});
