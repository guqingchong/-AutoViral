import { Hono } from "hono";
import { publishToPlatform, getPublishingStatus, triggerLogin, buildPublishInput } from "../../services/publishing.js";
import * as recordsRepo from "../../db/publish-records-repo.js";
import { getWork } from "../../db/works-repo.js";
import { readFile } from "node:fs/promises";

export const publishWorkRoutes = new Hono();

// POST /:platform — 发布到指定平台，body 可为空
publishWorkRoutes.post("/:platform", async (c) => {
  const workId = c.req.param("id");
  const platform = c.req.param("platform");
  const work = await getWork(workId);
  if (!work) return c.json({ error: "Work not found" }, 404);

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // empty body is fine — will use buildPublishInput
  }

  const input = body?.title
    ? {
        workId,
        videoPath: (body.videoPath as string) ?? "",
        coverPath: (body.coverPath as string) ?? undefined,
        title: body.title as string,
        options: (body.options as Record<string, unknown>) ?? {},
      }
    : await buildPublishInput(work, platform);

  const record = await publishToPlatform(workId, platform, input);
  return c.json(record);
});

// POST /:platform/login — 触发浏览器登录
publishWorkRoutes.post("/:platform/login", async (c) => {
  const platform = c.req.param("platform");
  if (!["douyin", "xiaohongshu"].includes(platform)) {
    return c.json({ error: "该平台不支持浏览器登录" }, 400);
  }
  const ok = await triggerLogin(platform);
  return c.json({ success: ok });
});

// GET /records — 获取所有发布记录
publishWorkRoutes.get("/records", async (c) => {
  const workId = c.req.param("id");
  const records = await getPublishingStatus(workId);
  return c.json({ publishRecords: records });
});

// GET /status — 获取发布状态（兼容 Phase 4a 接口）
publishWorkRoutes.get("/status", async (c) => {
  const workId = c.req.param("id");
  const records = await getPublishingStatus(workId);
  return c.json({ publishRecords: records });
});

// GET /:platform/fallback — 下载 fallback 导出包
publishWorkRoutes.get("/:platform/fallback", async (c) => {
  const workId = c.req.param("id");
  const platform = c.req.param("platform");
  const allRecords = recordsRepo.listPublishRecords({ workId });
  const record = allRecords.find(
    (r) => r.platform === platform && r.status === "fallback"
  );
  if (!record || !record.metadata) {
    return c.json({ error: "No fallback package available" }, 404);
  }
  const metadata = typeof record.metadata === "string"
    ? JSON.parse(record.metadata)
    : record.metadata;
  const packagePath = metadata.fallbackPackagePath as string | undefined;
  if (!packagePath) {
    return c.json({ error: "No fallback package available" }, 404);
  }
  try {
    const data = await readFile(packagePath);
    return new Response(data, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${platform}-fallback.zip"`,
      },
    });
  } catch {
    return c.json({ error: "Fallback package not found" }, 404);
  }
});
