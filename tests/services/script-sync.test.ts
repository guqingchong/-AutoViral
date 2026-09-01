/**
 * script-sync 单元测试(2026-09-01 "DB 脚本与成片文案不同源"修复)
 * 覆盖:ass 纯文本提取 / narration-final.md 优先 / ass 兜底 / 无 scriptId 不动作
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createScript, getScript } from "../../src/db/scripts-repo.js";
import { assToText, syncFinalNarrationToScript } from "../../src/services/script-sync.js";
import { extractNarration } from "../../src/services/digital-human-pipeline.js";

const ASS_SAMPLE = `[Script Info]
Title: test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\k50}今天{\\k30}我们聊
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\k40}三件事。\\N
Dialogue: 0,0:00:02.50,0:00:03.50,Default,,0,0,0,,第二行字幕
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,这不是字幕
`;

describe("assToText", () => {
  it("剥离 kf 标签/换行标记,只取 Dialogue 文本", () => {
    expect(assToText(ASS_SAMPLE)).toBe("今天我们聊三件事。第二行字幕");
  });

  it("空输入返回空串", () => {
    expect(assToText("")).toBe("");
  });
});

describe("syncFinalNarrationToScript", () => {
  let dir: string;
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    dir = mkdtempSync(join(tmpdir(), "script-sync-"));
    mkdirSync(join(dir, "output"), { recursive: true });
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("无 scriptId 不动作", () => {
    expect(syncFinalNarrationToScript(dir, null).synced).toBe(false);
  });

  it("narration-final.md 优先,回写后 extractNarration 读到最终稿", () => {
    const script = createScript({
      content: { scenes: [{ narration: "旧稿第一镜" }, { narration: "旧稿第二镜" }] },
      status: "draft",
    } as any);
    writeFileSync(join(dir, "output", "narration-final.md"), "  改写后的最终口播全文。  ");
    const r = syncFinalNarrationToScript(dir, script.id);
    expect(r).toMatchObject({ synced: true, source: "narration-final.md" });
    const updated = getScript(script.id!)!;
    // NARRATION_KEYS 首位是 narration → 下游自动读到最终稿
    expect(extractNarration(updated.content)).toBe("改写后的最终口播全文。");
    // 原 scenes 结构保留备查
    expect((updated.content as any).scenes).toHaveLength(2);
    expect((updated.content as any).narrationSyncedFrom).toBe("narration-final.md");
  });

  it("无 narration-final.md 时从最新 ass 兜底", () => {
    const script = createScript({ content: { narration: "旧稿" }, status: "draft" } as any);
    writeFileSync(join(dir, "output", "final.ass"), ASS_SAMPLE);
    const r = syncFinalNarrationToScript(dir, script.id);
    expect(r).toMatchObject({ synced: true, source: "final.ass" });
    expect(extractNarration(getScript(script.id!)!.content)).toBe("今天我们聊三件事。第二行字幕");
  });

  it("既无 narration-final 也无 ass 时不同步", () => {
    const script = createScript({ content: { narration: "旧稿" }, status: "draft" } as any);
    expect(syncFinalNarrationToScript(dir, script.id).synced).toBe(false);
    expect(extractNarration(getScript(script.id!)!.content)).toBe("旧稿");
  });

  it("内容相同则幂等跳过", () => {
    const script = createScript({ content: { narration: "相同文本" }, status: "draft" } as any);
    writeFileSync(join(dir, "output", "narration-final.md"), "相同文本");
    expect(syncFinalNarrationToScript(dir, script.id).synced).toBe(false);
  });
});
