import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEbur128, checkAssSubtitles, assertAssemblyDeliverables } from "../../src/services/quality-gate.js";

// P2-T3:机器门禁 —— ebur128 解析/字幕规范/assembly 交付物断言/advance 前置拦截

const EBUR128_SAMPLE = `
[Parsed_ebur128_0] t: 1.0  M: -20.1 S: -18.2  I: -16.0 LUFS  LRA: 4.2 LU
Summary:
  Integrated loudness:
    I:         -15.6 LUFS
    Threshold: -26.1 LUFS
  Loudness range:
    LRA:         4.4 LU
  True peak:
    Peak:       -4.4 dBFS
`;

const ASS_OK = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,短句合规
Dialogue: 0,0:00:03.00,0:00:06.00,Default,,0,0,0,,两行也合规\\N第二行短
`;
const ASS_BAD = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,这一行实在是太长太长太长太长一定会超框
Dialogue: 0,0:00:02.00,0:00:02.50,Default,,0,0,0,,半秒念九个字念不完
`;

describe("parseEbur128", () => {
  it("解析 Summary 段 I/TP 终值", () => {
    expect(parseEbur128(EBUR128_SAMPLE)).toEqual({ i: -15.6, tp: -4.4 });
  });
  it("无 Summary → null;静音 -inf → -Infinity", () => {
    expect(parseEbur128("no loudness here")).toBeNull();
    const silent = parseEbur128("Summary:\n Integrated loudness:\n  I: -inf LUFS\n True peak:\n  Peak: -inf dBFS");
    expect(silent?.i).toBe(-Infinity);
  });
});

describe("checkAssSubtitles", () => {
  it("合规字幕无违规", () => {
    expect(checkAssSubtitles(ASS_OK)).toEqual([]);
  });
  it("单行 >15 字与 CPS>8 各报一条", () => {
    const v = checkAssSubtitles(ASS_BAD);
    expect(v.some((x) => x.includes(">15"))).toBe(true);
    expect(v.some((x) => x.includes("CPS"))).toBe(true);
  });
});

describe("assertAssemblyDeliverables", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "av-gate-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("output 目录不存在 → 单条总述", () => {
    const issues = assertAssemblyDeliverables(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBe("output_dir");
  });

  it("缺 publish-text / report 指向不符 / 字幕违规 → 全部列出", async () => {
    const out = join(dir, "output");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "w_final.mp4"), "fake");
    await writeFile(join(out, "quality-report.json"), JSON.stringify({ videoPath: "/x/old.mp4" }));
    await writeFile(join(out, "subs.ass"), ASS_BAD);
    const keys = assertAssemblyDeliverables(dir).map((i) => i.key);
    expect(keys).toContain("publish_text");
    expect(keys).toContain("quality_report");
    expect(keys).toContain("subtitles");
  });

  it("交付物齐全且报告不早于成片 → 通过", async () => {
    const out = join(dir, "output");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "w_final.mp4"), "fake");
    await writeFile(join(out, "publish-text.md"), "# 标题\n正文");
    await writeFile(join(out, "subs.ass"), ASS_OK);
    // report 必须不早于 final:先建 final(旧时间)再建 report
    const old = new Date(Date.now() - 60_000);
    await utimes(join(out, "w_final.mp4"), old, old);
    await writeFile(join(out, "quality-report.json"), JSON.stringify({ videoPath: join(out, "w_final.mp4") }));
    expect(assertAssemblyDeliverables(dir)).toEqual([]);
  });
});

describe("advance assembly 机器门禁", () => {
  let dir: string;
  let apiRoutes: any;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "av-gate-api-"));
    process.env.AUTOVIRAL_DATA_DIR = dir;
    vi.resetModules();
    const conn = await import("../../src/db/connection.js");
    const { migrate } = await import("../../src/db/migrate.js");
    conn.resetInMemoryDb();
    migrate();
    ({ apiRoutes } = await import("../../src/server/api.js"));
  });
  afterEach(async () => {
    const { closeDb } = await import("../../src/db/connection.js");
    closeDb();
    await rm(dir, { recursive: true, force: true });
    delete process.env.AUTOVIRAL_DATA_DIR;
    vi.restoreAllMocks();
  });

  async function makeWorkAtAssembly(): Promise<string> {
    const { createWork, updateWork } = await import("../../src/work-store.js");
    const w = await createWork({ title: "门禁测试", type: "short-video", platforms: ["douyin"] } as never);
    const pipeline = { ...w.pipeline };
    for (const k of Object.keys(pipeline)) {
      pipeline[k] = { ...pipeline[k], status: k === "assembly" ? "active" : "done", startedAt: new Date().toISOString() };
    }
    await updateWork(w.id, { pipeline } as never);
    return w.id;
  }

  it("缺交付物 → 400 + 可读缺失清单", async () => {
    const id = await makeWorkAtAssembly();
    const res = await apiRoutes.request(`/api/works/${id}/pipeline/advance`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completedStep: "assembly" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("机器门禁");
    expect(body.issues.join()).toContain("final");
    expect(body.issues.join()).toContain("publish-text");
  });

  it("交付物齐全 → 正常推进", async () => {
    const id = await makeWorkAtAssembly();
    const out = join(dir, "works", id, "output");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "w_final.mp4"), "fake");
    await writeFile(join(out, "publish-text.md"), "# t");
    await writeFile(join(out, "subs.ass"), ASS_OK);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(out, "w_final.mp4"), old, old);
    await writeFile(join(out, "quality-report.json"), JSON.stringify({ videoPath: join(out, "w_final.mp4") }));
    const res = await apiRoutes.request(`/api/works/${id}/pipeline/advance`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completedStep: "assembly" }),
    });
    expect(res.status).toBe(200);
  });
});
