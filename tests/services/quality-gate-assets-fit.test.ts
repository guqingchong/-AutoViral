import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFFmpegPath } from "../../src/video/ffmpeg.js";
import { assertAssetsTimelineFit, assertAssetsConsistency } from "../../src/services/quality-gate.js";

const execFileAsync = promisify(execFile);

// 2026-09-18 实测根因(w_20260918_1519_b44 素材阶段连挂 4 轮):
// - 11 条旁白实测时长超过分镜计划时长(TTS 实测值与策划预估值从不由同一机器源产生)
// - 8 条在用素材实测时长 < timeline 契约时长
// - 弃用文件残留 clips/ 三轮被点名、shot-map 与 manifest 互相矛盾
// 修复:时长/音轨/引用一致性全部机器预检,拦截在 LLM 评审之前。

async function makeVideo(path: string, durationS: number, withAudio: boolean): Promise<void> {
  const ffmpeg = await getFFmpegPath();
  const args = [
    "-f", "lavfi", "-i", `testsrc=duration=${durationS}:size=320x240:rate=10`,
  ];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${durationS}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  else args.push("-an");
  args.push("-y", path);
  await execFileAsync(ffmpeg, args);
}

async function makeAudio(path: string, durationS: number): Promise<void> {
  const ffmpeg = await getFFmpegPath();
  await execFileAsync(ffmpeg, ["-f", "lavfi", "-i", `sine=frequency=440:duration=${durationS}`, "-y", path]);
}

interface ShotSpec { shot: number; duration: number; clip?: { file: string; actualS: number; audio?: boolean }; narrationS?: number }

async function seedWork(dir: string, shots: ShotSpec[], extraClips: string[] = []): Promise<void> {
  await mkdir(join(dir, "assets", "clips"), { recursive: true });
  await mkdir(join(dir, "assets", "audio"), { recursive: true });
  const timelineShots: unknown[] = [];
  const mapShots: unknown[] = [];
  for (const s of shots) {
    timelineShots.push({ shot: s.shot, start: 0, duration: s.duration });
    if (s.clip) {
      const rel = `assets/clips/${s.clip.file}`;
      await makeVideo(join(dir, rel), s.clip.actualS, s.clip.audio ?? true);
      mapShots.push({ i: s.shot, asset_file: rel, frames: [], narration: "……" });
    }
    if (s.narrationS !== undefined) {
      await makeAudio(join(dir, "assets", "audio", `shot-${String(s.shot).padStart(2, "0")}.mp3`), s.narrationS);
    }
  }
  for (const extra of extraClips) {
    await makeVideo(join(dir, "assets", "clips", extra), 3, true);
  }
  await writeFile(join(dir, "assets", "timeline.json"), JSON.stringify({ workId: "t", totalDurationS: 300, shots: timelineShots }), "utf-8");
  await writeFile(join(dir, "assets", "shot-map.json"), JSON.stringify({ workId: "t", shots: mapShots }), "utf-8");
}

describe("assertAssetsTimelineFit(时长/音轨机器预检)", () => {
  let root: string;
  let n = 0;
  let dir: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "av-fit-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  // 每个用例独立子目录,避免相互残留污染
  const fresh = async () => { dir = join(root, `case-${++n}`); await mkdir(dir, { recursive: true }); return dir; };

  it("时长匹配 → 无 issue", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 7.7, clip: { file: "a.mp4", actualS: 8 }, narrationS: 7 }]);
    expect(await assertAssetsTimelineFit(dir)).toEqual([]);
  });

  it("在用视频实测短于时间轴 → issue 附实测值", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 7.7, clip: { file: "a.mp4", actualS: 6 } }]);
    const issues = await assertAssetsTimelineFit(dir);
    expect(issues.map((i) => i.key)).toContain("clip_shorter_than_timeline");
    expect(issues[0].detail).toContain("6");
    expect(issues[0].detail).toContain("7.7");
  });

  it("逐镜旁白实测超过(镜时长-0.2s 安全尾) → issue 附实测值", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 7.7, clip: { file: "a.mp4", actualS: 8 }, narrationS: 8.2 }]);
    const issues = await assertAssetsTimelineFit(dir);
    expect(issues.map((i) => i.key)).toContain("narration_longer_than_shot");
  });

  it("在用视频无音频流 → issue(P0-1 归一化的防线兜底)", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 5, clip: { file: "a.mp4", actualS: 6, audio: false } }]);
    const issues = await assertAssetsTimelineFit(dir);
    expect(issues.map((i) => i.key)).toContain("clip_no_audio");
  });

  it("静态图片卡不参与时长/音轨检查", async () => {
    await fresh();
    await mkdir(join(dir, "assets", "clips"), { recursive: true });
    await writeFile(join(dir, "assets", "clips", "card.png"), "png");
    await writeFile(join(dir, "assets", "timeline.json"), JSON.stringify({ shots: [{ shot: 1, duration: 5 }] }), "utf-8");
    await writeFile(join(dir, "assets", "shot-map.json"), JSON.stringify({ shots: [{ i: 1, asset_file: "assets/clips/card.png", frames: [] }] }), "utf-8");
    expect(await assertAssetsTimelineFit(dir)).toEqual([]);
  });
});

describe("assertAssetsConsistency(引用/残留一致性预检)", () => {
  let root: string;
  let n = 0;
  let dir: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "av-consist-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const fresh = async () => { dir = join(root, `case-${++n}`); await mkdir(dir, { recursive: true }); return dir; };

  it("shot-map 引用不存在的文件 → issue", async () => {
    await fresh();
    await seedWork(dir, []);
    await writeFile(join(dir, "assets", "shot-map.json"), JSON.stringify({ shots: [{ i: 1, asset_file: "assets/clips/ghost.mp4", frames: [] }] }), "utf-8");
    expect((await assertAssetsConsistency(dir)).map((i) => i.key)).toContain("shot_map_file_missing");
  });

  it("shot-map 引用 _archive 弃用文件 → issue", async () => {
    await fresh();
    await seedWork(dir, []);
    await mkdir(join(dir, "assets", "_archive"), { recursive: true });
    await writeFile(join(dir, "assets", "_archive", "old.mp4"), "x");
    await writeFile(join(dir, "assets", "shot-map.json"), JSON.stringify({ shots: [{ i: 1, asset_file: "assets/_archive/old.mp4", frames: [] }] }), "utf-8");
    expect((await assertAssetsConsistency(dir)).map((i) => i.key)).toContain("shot_map_archived_ref");
  });

  it("clips 下未引用且未归档的残留媒体 → issue", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 5, clip: { file: "used.mp4", actualS: 6 } }], ["leftover.mp4"]);
    const issues = await assertAssetsConsistency(dir);
    expect(issues.map((i) => i.key)).toContain("clips_residual_unreferenced");
    expect(issues.find((i) => i.key === "clips_residual_unreferenced")!.detail).toContain("leftover.mp4");
  });

  it("全部被引用或归档 → 无 issue(下划线开头的草稿文件豁免)", async () => {
    await fresh();
    await seedWork(dir, [{ shot: 1, duration: 5, clip: { file: "used.mp4", actualS: 6 } }]);
    await mkdir(join(dir, "assets", "clips", "code"), { recursive: true });
    await writeFile(join(dir, "assets", "clips", "_draft.mp4"), "x"); // 下划线豁免
    expect(await assertAssetsConsistency(dir)).toEqual([]);
  });
});
