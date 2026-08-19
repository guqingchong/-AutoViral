/**
 * 发布文案链路测试(2026-08-19 P0):文件名统一 publish-text.md + buildPublishInput 消费。
 * 背景:门禁强制产出 publish-text.md,但此前无消费者——发出去的是作品标题+文章截断;
 * 且阶段提示词让写 copytext.md 与门禁文件名打架。
 *
 * 注意:src 模块必须动态 import——ESM 静态导入会被提升,env 赋值来不及生效
 * (config.ts 的 dataDir 在模块求值时定型)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "publish-text-test-"));
process.env.AUTOVIRAL_DATA_DIR = TEST_DATA_DIR;

let parsePublishText: (typeof import("../../src/services/publishing.js"))["parsePublishText"];
let buildPublishInput: (typeof import("../../src/services/publishing.js"))["buildPublishInput"];
let createWork: (typeof import("../../src/work-store.js"))["createWork"];
let getWork: (typeof import("../../src/work-store.js"))["getWork"];
let closeDb: (typeof import("../../src/db/connection.js"))["closeDb"];

beforeAll(async () => {
  const [pub, ws, conn, mig] = await Promise.all([
    import("../../src/services/publishing.js"),
    import("../../src/work-store.js"),
    import("../../src/db/connection.js"),
    import("../../src/db/migrate.js"),
  ]);
  parsePublishText = pub.parsePublishText;
  buildPublishInput = pub.buildPublishInput;
  createWork = ws.createWork;
  getWork = ws.getWork;
  closeDb = conn.closeDb;
  mig.migrate();
});

afterAll(() => {
  closeDb();
  // 清理 env,防止 fork 复用时泄漏给后续测试文件(config.ts 的 dataDir 读此变量)
  delete process.env.AUTOVIRAL_DATA_DIR;
});

describe("parsePublishText", () => {
  it("首行=标题,中段=正文,最后一行 # =标签", () => {
    const md = "城投转型不是换牌子,是换DNA\n\n很多人没看懂这轮剥离的真正含义。\n\n觉得有用就收藏 👆\n\n#城投 #财经 #政策解读";
    const r = parsePublishText(md);
    expect(r.title).toBe("城投转型不是换牌子,是换DNA");
    expect(r.body).toContain("很多人没看懂");
    expect(r.body).toContain("收藏");
    expect(r.tags).toEqual(["城投", "财经", "政策解读"]);
  });

  it("只有标题无标签也能解析", () => {
    const r = parsePublishText("一句话标题");
    expect(r.title).toBe("一句话标题");
    expect(r.tags).toBeUndefined();
  });

  it("空内容返回空对象", () => {
    expect(parsePublishText("\n  \n")).toEqual({});
  });
});

describe("buildPublishInput 消费 publish-text.md", () => {
  it("标题/正文/标签优先取自 publish-text.md,而非作品标题", async () => {
    const work = await createWork({
      title: "原始作品标题(选题名)",
      type: "short-video",
      platforms: ["douyin"],
    });
    const outDir = join(TEST_DATA_DIR, "works", work.id, "output");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "publish-text.md"),
      "爆款钩子标题\n\n正文第一句。\n正文第二句。\n\n#城投 #干货", "utf-8");

    const dbWork = (await getWork(work.id)) as any;
    const input = await buildPublishInput(dbWork, "douyin");
    expect(input.title).toBe("爆款钩子标题");
    expect(input.options?.description).toContain("正文第一句");
    expect(input.options?.tags).toEqual(["城投", "干货"]);
  });

  it("无 publish-text.md 时回落作品标题", async () => {
    const work = await createWork({
      title: "无文案作品",
      type: "short-video",
      platforms: ["douyin"],
    });
    const dbWork = (await getWork(work.id)) as any;
    const input = await buildPublishInput(dbWork, "douyin");
    expect(input.title).toBe("无文案作品");
    expect(input.options?.tags).toBeUndefined();
  });
});
