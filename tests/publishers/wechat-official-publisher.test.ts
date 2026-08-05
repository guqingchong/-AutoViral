import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { setCredential } from "../../src/db/platform-credentials-repo.js";
import {
  WechatOfficialPublisher,
  planImageInsertions,
} from "../../src/services/publishers/wechat-official-publisher.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
}));

interface FetchCall {
  url: string;
  body?: unknown;
}

function installFetchMock(record: { calls: FetchCall[]; draftContent?: string }) {
  global.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    record.calls.push({ url: u, body: init?.body });
    if (u.includes("/token?")) {
      return { json: async () => ({ access_token: "tk", expires_in: 7200 }) };
    }
    if (u.includes("/material/add_material")) {
      return { json: async () => ({ media_id: "thumb_media_1" }) };
    }
    if (u.includes("/media/uploadimg")) {
      const n = record.calls.filter((c) => c.url.includes("/media/uploadimg")).length;
      return { json: async () => ({ url: `https://wx-content-img/${n}.jpg` }) };
    }
    if (u.includes("/draft/add")) {
      const parsed = JSON.parse(String(init?.body));
      record.draftContent = parsed.articles[0].content;
      return { json: async () => ({ errcode: 0, media_id: "draft_media_1" }) };
    }
    if (u.includes("/freepublish/submit")) {
      return { json: async () => ({ errcode: 0, publish_id: "pub_1" }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe("planImageInsertions", () => {
  it("无段落或无图时返回空", () => {
    expect(planImageInsertions(0, 3)).toEqual([]);
    expect(planImageInsertions(5, 0)).toEqual([]);
  });

  it("均匀分布且保持每 2~3 段一张", () => {
    // 6 段 2 图 → 插在第 3、5 段之后（0 起索引 2、4）
    expect(planImageInsertions(6, 2)).toEqual([2, 4]);
    // 10 段 3 图 → 索引 2、5、7
    expect(planImageInsertions(10, 3)).toEqual([2, 5, 7]);
  });

  it("图片多于段落承载量时按每 2 段一张截断", () => {
    const positions = planImageInsertions(4, 10);
    expect(positions).toEqual([1, 2]);
  });

  it("单段落也至少能插一张", () => {
    expect(planImageInsertions(1, 3)).toEqual([0]);
  });
});

describe("WechatOfficialPublisher 正文配图", () => {
  let origFetch: typeof global.fetch;
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    vi.clearAllMocks();
    origFetch = global.fetch;
    setCredential("wechat", "app_id", "appid");
    setCredential("wechat", "app_secret", "secret");
  });
  afterEach(() => {
    global.fetch = origFetch;
    closeDb();
  });

  const sixParagraphs = ["第一段", "第二段", "第三段", "第四段", "第五段", "第六段"].join("\n");

  it("有 contentImages 时通过 uploadimg 上传并按段落插图", async () => {
    const record: { calls: FetchCall[]; draftContent?: string } = { calls: [] };
    installFetchMock(record);

    const pub = new WechatOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      coverPath: "/tmp/cover.jpg",
      title: "标题",
      options: {
        content: sixParagraphs,
        contentImages: ["/tmp/a.png", "/tmp/b.png"],
      },
    });

    expect(res.success).toBe(true);
    const uploadCalls = record.calls.filter((c) => c.url.includes("/media/uploadimg"));
    expect(uploadCalls.length).toBe(2);

    const html = record.draftContent!;
    expect(html).toContain('<img src="https://wx-content-img/1.jpg"');
    expect(html).toContain('<img src="https://wx-content-img/2.jpg"');
    // 插图位置：第 3 段和第 5 段之后（planImageInsertions(6,2) = [2,4]）
    expect(html).toBe(
      "<p>第一段</p><p>第二段</p><p>第三段</p>" +
        '<p><img src="https://wx-content-img/1.jpg" /></p>' +
        "<p>第四段</p><p>第五段</p>" +
        '<p><img src="https://wx-content-img/2.jpg" /></p>' +
        "<p>第六段</p>"
    );
  });

  it("无 contentImages 时维持纯文本，不调用 uploadimg", async () => {
    const record: { calls: FetchCall[]; draftContent?: string } = { calls: [] };
    installFetchMock(record);

    const pub = new WechatOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      coverPath: "/tmp/cover.jpg",
      title: "标题",
      options: { content: sixParagraphs },
    });

    expect(res.success).toBe(true);
    expect(record.calls.some((c) => c.url.includes("/media/uploadimg"))).toBe(false);
    expect(record.draftContent).not.toContain("<img");
    expect(record.draftContent).toBe(
      "<p>第一段</p><p>第二段</p><p>第三段</p><p>第四段</p><p>第五段</p><p>第六段</p>"
    );
  });

  it("uploadimg 全部失败时回退纯文本且发布不中断", async () => {
    const record: { calls: FetchCall[]; draftContent?: string } = { calls: [] };
    installFetchMock(record);
    const baseFetch = global.fetch;
    global.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      if (u.includes("/media/uploadimg")) {
        record.calls.push({ url: u, body: init?.body });
        return { json: async () => ({ errcode: 40001, errmsg: "invalid credential" }) };
      }
      return (baseFetch as unknown as (u: unknown, i?: unknown) => unknown)(url, init);
    }) as unknown as typeof fetch;

    const pub = new WechatOfficialPublisher();
    const res = await pub.publish({
      workId: "w1",
      videoPath: "/tmp/v.mp4",
      coverPath: "/tmp/cover.jpg",
      title: "标题",
      options: { content: sixParagraphs, contentImages: ["/tmp/a.png"] },
    });

    expect(res.success).toBe(true);
    expect(record.draftContent).not.toContain("<img");
  });
});
