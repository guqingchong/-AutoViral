import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createWork as dbCreateWork } from "../../src/db/works-repo.js";
import { createArticle } from "../../src/db/articles-repo.js";
import { createTemplate } from "../../src/db/templates-repo.js";
import { buildPublishInput } from "../../src/services/publishing.js";
import {
  splitArticleToCardCopy,
  normalizeLlmCardCopy,
  generateCardCopy,
  buildCardHtml,
  layoutSpecsFromTemplate,
  resolveCardLayout,
  renderCardsToPng,
  deriveDualOutputs,
} from "../../src/services/dual-output.js";
import type { DbWork } from "../../src/db/types.js";

vi.mock("../../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/config.js")>();
  const dir = await mkdtemp(join(tmpdir(), "autoviral-dual-output-test-"));
  return { ...orig, dataDir: dir, __testDataDir: dir };
});

async function testDataDir(): Promise<string> {
  const config = await import("../../src/config.js");
  return (config as unknown as { __testDataDir: string }).__testDataDir;
}

function makeWork(overrides: Partial<DbWork> = {}): DbWork {
  return {
    id: "w_dual",
    title: "双产物作品",
    type: "short-video",
    status: "reviewing",
    platforms: ["douyin", "xiaohongshu"],
    evaluation_mode: false,
    tags: [],
    dual_output: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as DbWork;
}

function makeImageTextTemplate(id = "tpl_it_test01") {
  return createTemplate({
    id,
    name: "测试图文模板",
    content_form: "image-text",
    canvas: { width: 1080, height: 1440, fps: 30, backgroundColor: "#FFFFFF" },
    variables: [],
    layers: [
      {
        id: "cover", type: "image-text-layout", page: "cover",
        layout: "big_title_center", font: "Noto Sans SC", fontSize: 96,
        colorScheme: { background: "#FFF7E6", primary: "#1A1A1A", text: "#333333", accent: "#FF8800" },
        decorations: ["accent_bar"],
      },
      {
        id: "content-page", type: "image-text-layout", page: "content",
        layout: "top_block", font: "Noto Sans SC", fontSize: 56,
        colorScheme: { background: "#FFF7E6", primary: "#1A1A1A", text: "#333333", accent: "#FF8800" },
        decorations: ["serial_number"],
      },
    ],
    audio: [],
    transitions: [],
    status: "approved",
    kind: "image-text",
  });
}

describe("dual-output service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  describe("splitArticleToCardCopy（程序化拆分）", () => {
    it("按空行分段打包成内容卡，封面取标题", () => {
      const copy = splitArticleToCardCopy(
        "三天搞懂退休金",
        "第一段内容。\n\n第二段内容。\n\n第三段内容。",
      );
      expect(copy.coverTitle).toBe("三天搞懂退休金");
      expect(copy.pages.length).toBe(3);
      expect(copy.pages[0].body).toBe("第一段内容。");
    });

    it("无空行时按单行切分", () => {
      const copy = splitArticleToCardCopy("t", "甲\n乙\n丙");
      expect(copy.pages.map((p) => p.body)).toEqual(["甲", "乙", "丙"]);
    });

    it("段落超过字数上限按句子边界再切", () => {
      const long = "甲".repeat(50) + "。" + "乙".repeat(50) + "。" + "丙".repeat(50) + "。";
      const copy = splitArticleToCardCopy("t", long, { maxBodyChars: 60 });
      expect(copy.pages.length).toBeGreaterThan(1);
      for (const p of copy.pages) expect(p.body.length).toBeLessThanOrEqual(60);
      expect(copy.pages.map((p) => p.body).join("")).toContain("丙");
    });

    it("卡片数量不超过上限", () => {
      const content = Array.from({ length: 20 }, (_, i) => `第${i}段` + "文".repeat(50)).join("\n\n");
      const copy = splitArticleToCardCopy("t", content, { maxPages: 4, maxBodyChars: 60 });
      expect(copy.pages.length).toBeLessThanOrEqual(4);
    });

    it("去掉 markdown 标记", () => {
      const copy = splitArticleToCardCopy("t", "## 标题\n\n**加粗**内容和[链接](https://x.com)![图](a.png)");
      const all = copy.pages.map((p) => p.body).join("\n");
      expect(all).not.toContain("#");
      expect(all).not.toContain("**");
      expect(all).not.toContain("https://x.com");
      expect(all).toContain("加粗");
      expect(all).toContain("链接");
    });

    it("空正文返回空 pages，封面仍有标题", () => {
      const copy = splitArticleToCardCopy("只有标题", "");
      expect(copy.coverTitle).toBe("只有标题");
      expect(copy.pages).toEqual([]);
    });
  });

  describe("normalizeLlmCardCopy（LLM 产出校验）", () => {
    it("接受合法产出并做长度截断", () => {
      const raw = {
        coverTitle: "封".repeat(30),
        coverSubtitle: "副标题",
        pages: [
          { heading: "要点一", body: "内容一" },
          { heading: "要点二", body: "内容二" },
        ],
      };
      const copy = normalizeLlmCardCopy(raw, "兜底标题");
      expect(copy).not.toBeNull();
      expect(copy!.coverTitle.length).toBeLessThanOrEqual(20);
      expect(copy!.coverSubtitle).toBe("副标题");
      expect(copy!.pages).toHaveLength(2);
      expect(copy!.pages[0].heading).toBe("要点一");
    });

    it("pages 为空/全非字符串 body 时返回 null", () => {
      expect(normalizeLlmCardCopy({ coverTitle: "t", pages: [] }, "f")).toBeNull();
      expect(normalizeLlmCardCopy({ pages: [{ heading: "h" }] }, "f")).toBeNull();
      expect(normalizeLlmCardCopy(null, "f")).toBeNull();
      expect(normalizeLlmCardCopy("str", "f")).toBeNull();
    });

    it("coverTitle 缺失回退兜底标题，空 body 页被丢弃，页数封顶 8", () => {
      const raw = {
        pages: [
          { body: "" },
          ...Array.from({ length: 10 }, (_, i) => ({ body: `内容${i}` })),
        ],
      };
      const copy = normalizeLlmCardCopy(raw, "兜底标题");
      expect(copy!.coverTitle).toBe("兜底标题");
      expect(copy!.pages.length).toBe(8);
      expect(copy!.pages[0].body).toBe("内容0");
    });
  });

  describe("generateCardCopy（LLM + 回退）", () => {
    const article = { title: "文章标题", content: "第一段。\n\n第二段。" };

    it("LLM 产出合法时直接用 LLM 结果", async () => {
      const copy = await generateCardCopy(article, {
        llm: async () => ({ coverTitle: "爆款标题", pages: [{ heading: "h", body: "b" }] }),
      });
      expect(copy.coverTitle).toBe("爆款标题");
      expect(copy.pages).toEqual([{ heading: "h", body: "b" }]);
    });

    it("LLM 产出不可用时回退程序化拆分", async () => {
      const copy = await generateCardCopy(article, { llm: async () => ({ pages: [] }) });
      expect(copy.coverTitle).toBe("文章标题");
      expect(copy.pages.length).toBe(2);
    });

    it("LLM 抛错时回退程序化拆分", async () => {
      const copy = await generateCardCopy(article, {
        llm: async () => { throw new Error("CLI 限流"); },
      });
      expect(copy.coverTitle).toBe("文章标题");
      expect(copy.pages.length).toBe(2);
    });
  });

  describe("buildCardHtml（版式渲染 HTML）", () => {
    const spec = {
      layout: "big_title_center",
      font: "Noto Sans SC",
      fontSize: 96,
      colorScheme: { background: "#FFF7E6", primary: "#111111", text: "#222222", accent: "#FF8800" },
      decorations: ["accent_bar"],
    };
    const canvas = { width: 1080, height: 1440 };

    it("封面卡包含标题、配色与字体", () => {
      const html = buildCardHtml({ spec, canvas, kind: "cover", title: "封面标题", subtitle: "副标题" });
      expect(html).toContain("封面标题");
      expect(html).toContain("副标题");
      expect(html).toContain("#FFF7E6");
      expect(html).toContain("Noto Sans SC");
      expect(html).toContain("1080px");
      expect(html).toContain("accent-bar");
    });

    it("内容卡含序号装饰，正文换行转 <br/>，HTML 被转义", () => {
      const contentSpec = { ...spec, fontSize: 56, decorations: ["serial_number"] };
      const html = buildCardHtml({
        spec: contentSpec, canvas, kind: "content",
        heading: "要点", body: "第一行<script>\n第二行", index: 2, total: 5,
      });
      expect(html).toContain("02 / 05");
      expect(html).toContain("第一行&lt;script&gt;<br/>第二行");
      expect(html).not.toContain("<script>");
    });
  });

  describe("版式解析", () => {
    it("从 image-text 模板 layers 提取 cover/content 版式", () => {
      const tpl = makeImageTextTemplate();
      const specs = layoutSpecsFromTemplate(tpl);
      expect(specs).not.toBeNull();
      expect(specs!.cover.layout).toBe("big_title_center");
      expect(specs!.content.layout).toBe("top_block");
      expect(specs!.cover.colorScheme.accent).toBe("#FF8800");
    });

    it("video 模板不提取版式", () => {
      const tpl = createTemplate({
        id: "tpl_video1", name: "视频模板",
        canvas: { width: 1080, height: 1920, fps: 30 },
        variables: [], layers: [], audio: [], transitions: [],
        status: "approved", kind: "video",
      });
      expect(layoutSpecsFromTemplate(tpl)).toBeNull();
    });

    it("resolveCardLayout：作品模板是 image-text 时优先使用", () => {
      makeImageTextTemplate("tpl_it_own");
      const layout = resolveCardLayout("tpl_it_own");
      expect(layout.templateId).toBe("tpl_it_own");
      expect(layout.canvas).toEqual({ width: 1080, height: 1440 });
    });

    it("resolveCardLayout：作品模板是视频模板时回退到最新图文模板", () => {
      createTemplate({
        id: "tpl_video2", name: "视频模板",
        canvas: { width: 1080, height: 1920, fps: 30 },
        variables: [], layers: [], audio: [], transitions: [],
        status: "approved", kind: "video",
      });
      makeImageTextTemplate("tpl_it_latest");
      const layout = resolveCardLayout("tpl_video2");
      expect(layout.templateId).toBe("tpl_it_latest");
    });

    it("resolveCardLayout：无任何模板时用内置默认版式", () => {
      const layout = resolveCardLayout(undefined);
      expect(layout.templateId).toBeUndefined();
      expect(layout.cover.layout).toBe("big_title_center");
      expect(layout.canvas.width).toBe(1080);
    });
  });

  describe("renderCardsToPng（渲染编排，出图 mock）", () => {
    it("封面在前，内容卡按序命名，写入目标目录", async () => {
      const dir = await testDataDir();
      const outDir = join(dir, "render-out");
      const written: string[] = [];
      const result = await renderCardsToPng(
        { coverTitle: "封面", pages: [{ body: "A" }, { heading: "h", body: "B" }] },
        resolveCardLayout(undefined),
        outDir,
        async (_html, outPath) => {
          written.push(outPath);
          await writeFile(outPath, "png-bytes");
        },
      );
      expect(result.files.map((f) => f.split(/[\\/]/).pop())).toEqual([
        "01-cover.png", "02-card.png", "03-card.png",
      ]);
      expect(written).toHaveLength(3);
      const files = await readdir(outDir);
      expect(files.sort()).toEqual(["01-cover.png", "02-card.png", "03-card.png"]);
    });
  });

  describe("deriveDualOutputs（派生主流程）", () => {
    async function seedDualWork(id = "w_dual") {
      dbCreateWork(makeWork({ id }), []);
      createArticle({ work_id: id, title: "文章标题", content: "第一段。\n\n第二段。", status: "ready" });
    }

    it("非双产物作品返回 null（不派生）", async () => {
      dbCreateWork(makeWork({ id: "w_plain", dual_output: false }), []);
      expect(await deriveDualOutputs("w_plain")).toBeNull();
      expect(await deriveDualOutputs("w_missing")).toBeNull();
    });

    it("双产物作品产出卡片 PNG + 清单，文章接线验证通过", async () => {
      await seedDualWork();
      const rendered: string[] = [];
      const result = await deriveDualOutputs("w_dual", {
        generateCopy: async () => ({ coverTitle: "封面", pages: [{ body: "卡一" }, { body: "卡二" }] }),
        generateCaption: async () => "测试配文",
        render: async (_html, outPath) => {
          rendered.push(outPath);
          await writeFile(outPath, "png");
        },
      });
      expect(result).not.toBeNull();
      expect(result!.articleReady).toBe(true);
      expect(result!.cardFiles).toHaveLength(3);
      expect(rendered).toHaveLength(3);
      // 2026-08-07 起派生独立图文子作品:卡片渲染到子作品目录
      const childId = result!.childWorkId!;
      expect(childId).toBeTruthy();
      expect(childId).not.toBe("w_dual");
      const { getWork } = await import("../../src/db/works-repo.js");
      const child = getWork(childId);
      expect(child?.type).toBe("image-text");
      expect(child?.parent_work_id).toBe("w_dual");
      expect(child?.status).toBe("reviewing");

      const dir = await testDataDir();
      const cardsDir = join(dir, "works", childId, "output", "cards");
      const manifest = JSON.parse(await readFile(join(cardsDir, "cards.json"), "utf-8"));
      expect(manifest.workId).toBe(childId);
      expect(manifest.parentWorkId).toBe("w_dual");
      expect(manifest.files).toEqual(["01-cover.png", "02-card.png", "03-card.png"]);
    });

    it("无文章时不渲染卡片、articleReady=false，但不抛异常", async () => {
      dbCreateWork(makeWork({ id: "w_noart" }), []);
      const result = await deriveDualOutputs("w_noart");
      expect(result).not.toBeNull();
      expect(result!.articleReady).toBe(false);
      expect(result!.cardFiles).toEqual([]);
    });

    it("渲染失败不阻塞：记日志并返回部分结果，不抛异常", async () => {
      await seedDualWork("w_dual");
      const result = await deriveDualOutputs("w_dual", {
        generateCopy: async () => ({ coverTitle: "c", pages: [{ body: "b" }] }),
        generateCaption: async () => "测试配文",
        render: async () => { throw new Error("chromium 启动失败"); },
      });
      expect(result).not.toBeNull();
      expect(result!.articleReady).toBe(true);
      expect(result!.cardFiles).toEqual([]);
    });

    it("使用作品自带的 image-text 模板版式渲染", async () => {
      await seedDualWork();
      makeImageTextTemplate("tpl_it_own2");
      // 把模板绑到作品上
      const { updateWork } = await import("../../src/db/works-repo.js");
      await updateWork("w_dual", { template_id: "tpl_it_own2" });

      const htmls: string[] = [];
      await deriveDualOutputs("w_dual", {
        generateCopy: async () => ({ coverTitle: "封面", pages: [{ body: "卡一" }] }),
        generateCaption: async () => "测试配文",
        render: async (html, outPath) => {
          htmls.push(html);
          await writeFile(outPath, "png");
        },
      });
      // 模板配色 #FF8800 / 背景 #FFF7E6 应出现在卡片 HTML 中
      expect(htmls.some((h) => h.includes("#FF8800"))).toBe(true);
      expect(htmls.some((h) => h.includes("#FFF7E6"))).toBe(true);
    });
  });

  describe("buildPublishInput 小红书卡片注入（发布链路接线）", () => {
    it("cards 目录存在时注入 imagePaths（封面在前）与配文", async () => {
      const dir = await testDataDir();
      const workId = "w_xhs";
      dbCreateWork(makeWork({ id: workId }), []);
      createArticle({ work_id: workId, title: "标题", content: "正文内容", status: "ready" });
      const cardsDir = join(dir, "works", workId, "output", "cards");
      await mkdir(cardsDir, { recursive: true });
      await writeFile(join(cardsDir, "02-card.png"), "png");
      await writeFile(join(cardsDir, "01-cover.png"), "png");

      // image-text 作品(图文子作品)才走图文笔记链路(2026-08-07 分块约定)
      const input = await buildPublishInput(makeWork({ id: workId, type: "image-text" }), "xiaohongshu");
      const imagePaths = input.options?.imagePaths as string[];
      expect(imagePaths).toHaveLength(2);
      expect(imagePaths[0].endsWith("01-cover.png")).toBe(true);
      expect(imagePaths[1].endsWith("02-card.png")).toBe(true);
      expect(input.options?.description).toBe("正文内容");
    });

    it("无 cards 目录时不注入 imagePaths（维持视频链路）", async () => {
      dbCreateWork(makeWork({ id: "w_nocards" }), []);
      const input = await buildPublishInput(makeWork({ id: "w_nocards" }), "xiaohongshu");
      expect(input.options?.imagePaths).toBeUndefined();
    });

    it("short-video 作品即使有 cards 也不注入（视频页小红书只发视频）", async () => {
      const dir = await testDataDir();
      const workId = "w_xhs_video";
      dbCreateWork(makeWork({ id: workId }), []);
      const cardsDir = join(dir, "works", workId, "output", "cards");
      await mkdir(cardsDir, { recursive: true });
      await writeFile(join(cardsDir, "01-cover.png"), "png");

      const input = await buildPublishInput(makeWork({ id: workId, type: "short-video" }), "xiaohongshu");
      expect(input.options?.imagePaths).toBeUndefined();
    });
  });
});
