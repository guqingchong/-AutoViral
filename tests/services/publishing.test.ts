import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import * as recordsRepo from "../../src/db/publish-records-repo.js";
import { createArticle } from "../../src/db/articles-repo.js";
import { createWork as dbCreateWork } from "../../src/db/works-repo.js";
import { getPublishingStatus, toPublishRecord, buildPublishInput } from "../../src/services/publishing.js";
import type { DbWork } from "../../src/db/types.js";

vi.mock("../../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/config.js")>();
  const dir = await mkdtemp(join(tmpdir(), "autoviral-publishing-test-"));
  return { ...orig, dataDir: dir, __testDataDir: dir };
});

describe("publishing service", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("toPublishRecord maps DB row to PublishRecord", () => {
    const now = new Date().toISOString();
    const created = recordsRepo.createPublishRecord({
      work_id: "w1",
      platform: "douyin",
      status: "published",
    });
    const row = recordsRepo.getPublishRecord(created.id);
    const record = toPublishRecord(row!);
    expect(record.workId).toBe("w1");
    expect(record.platform).toBe("douyin");
    expect(record.status).toBe("published");
  });

  it("getPublishingStatus returns PublishRecord[]", async () => {
    recordsRepo.createPublishRecord({ work_id: "w1", platform: "fake", status: "published" });
    const status = await getPublishingStatus("w1");
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status[0].status).toBe("published");
  });

  describe("buildPublishInput 正文配图注入", () => {
    const work = { id: "w_img", title: "图文作品" } as unknown as DbWork;

    async function seedWorkFiles(dataDir: string): Promise<void> {
      const workDir = join(dataDir, "works", "w_img");
      await mkdir(join(workDir, "assets", "images"), { recursive: true });
      await mkdir(join(workDir, "output"), { recursive: true });
      await writeFile(join(workDir, "assets", "images", "b.png"), "img");
      await writeFile(join(workDir, "assets", "images", "a.jpg"), "img");
      await writeFile(join(workDir, "assets", "images", "notes.txt"), "not-image");
      await writeFile(join(workDir, "output", "cover.jpg"), "cover");
      await writeFile(join(workDir, "output", "card1.png"), "card");
    }

    it("知乎/公众号平台收集素材图并排除封面", async () => {
      const config = await import("../../src/config.js");
      const dataDir = (config as unknown as { __testDataDir: string }).__testDataDir;
      await seedWorkFiles(dataDir);
      dbCreateWork(
        {
          id: "w_img",
          title: "图文作品",
          type: "image-text",
          status: "reviewing",
          platforms: ["zhihu"],
          evaluation_mode: false,
          tags: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        []
      );
      createArticle({ work_id: "w_img", title: "文章", content: "正文", status: "ready" });

      const input = await buildPublishInput(work, "zhihu");
      const images = input.options?.contentImages as string[];
      expect(Array.isArray(images)).toBe(true);
      expect(images.some((p) => p.endsWith("a.jpg"))).toBe(true);
      expect(images.some((p) => p.endsWith("b.png"))).toBe(true);
      expect(images.some((p) => p.endsWith("card1.png"))).toBe(true);
      expect(images.some((p) => p.endsWith("cover.jpg"))).toBe(false);
      expect(images.some((p) => p.endsWith("notes.txt"))).toBe(false);
      // 排序确定
      expect([...images].sort()).toEqual(images);
      expect(input.options?.content).toBe("正文");

      // wechat_mp 别名同样注入
      const wxInput = await buildPublishInput(work, "wechat_mp");
      expect(Array.isArray(wxInput.options?.contentImages)).toBe(true);
    });

    it("非文章平台不注入 contentImages", async () => {
      const config = await import("../../src/config.js");
      const dataDir = (config as unknown as { __testDataDir: string }).__testDataDir;
      await seedWorkFiles(dataDir);

      const input = await buildPublishInput(work, "douyin");
      expect(input.options?.contentImages).toBeUndefined();
    });

    it("无素材图时注入空数组", async () => {
      const input = await buildPublishInput(
        { id: "w_noimg", title: "纯文本" } as unknown as DbWork,
        "zhihu"
      );
      expect(input.options?.contentImages).toEqual([]);
    });
  });
});
