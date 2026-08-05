import { Hono } from "hono";
import * as queueRepo from "../../db/work-queue-repo.js";
import { kickRunner } from "../../services/work-queue.js";
import { getWork, deleteWork } from "../../work-store.js";

export const queueRoutes = new Hono();

/**
 * 数字人渲染池同步：syncRenderPool 由 Task 6 在 digital-human-pipeline 中提供。
 * 动态 import + 可选调用 —— 函数尚不存在（或同步失败）时静默跳过，
 * 保证本路由在 Task 6 落地前独立可用、可测。
 */
async function trySyncRenderPool(): Promise<void> {
  try {
    const mod = (await import("../../services/digital-human-pipeline.js")) as {
      syncRenderPool?: () => unknown;
    };
    if (typeof mod.syncRenderPool === "function") {
      await mod.syncRenderPool();
    }
  } catch {
    // Task 6 未就绪：不阻塞队列操作
  }
}

/** 每个变更端点操作后调用：唤醒串行 runner + 同步渲染池 */
async function afterQueueChange(): Promise<void> {
  kickRunner();
  await trySyncRenderPool();
}

// GET / — 队列列表，附带作品标题/状态（逐个 getWork，作品已删时标记 missing）
queueRoutes.get("/", async (c) => {
  const items = queueRepo.listQueue();
  const enriched = await Promise.all(
    items.map(async (item) => {
      const work = await getWork(item.workId).catch(() => undefined);
      return {
        ...item,
        title: work?.title ?? "",
        workStatus: work?.status ?? "missing",
      };
    }),
  );
  return c.json({ items: enriched });
});

// POST /:workId/prioritize — 插队到 queued 队首（running 之后）
queueRoutes.post("/:workId/prioritize", async (c) => {
  const workId = c.req.param("workId");
  if (!queueRepo.getItem(workId)) return c.json({ error: "Queue item not found" }, 404);
  queueRepo.prioritize(workId);
  await afterQueueChange();
  return c.json({ item: queueRepo.getItem(workId) });
});

// POST /:workId/pause — 暂停（queued/running → paused）
queueRoutes.post("/:workId/pause", async (c) => {
  const workId = c.req.param("workId");
  const item = queueRepo.getItem(workId);
  if (!item) return c.json({ error: "Queue item not found" }, 404);
  if (item.status === "done" || item.status === "failed") {
    return c.json({ error: `cannot pause item in terminal status: ${item.status}` }, 409);
  }
  queueRepo.setStatus(workId, "paused");
  await afterQueueChange();
  return c.json({ item: queueRepo.getItem(workId) });
});

// POST /:workId/resume — 恢复排队（→ queued，保留原 position）
queueRoutes.post("/:workId/resume", async (c) => {
  const workId = c.req.param("workId");
  if (!queueRepo.getItem(workId)) return c.json({ error: "Queue item not found" }, 404);
  queueRepo.setStatus(workId, "queued");
  await afterQueueChange();
  return c.json({ item: queueRepo.getItem(workId) });
});

// POST /:workId/remove — 移出队列转手动制作池，作品本身保留
queueRoutes.post("/:workId/remove", async (c) => {
  const workId = c.req.param("workId");
  if (!queueRepo.getItem(workId)) return c.json({ error: "Queue item not found" }, 404);
  queueRepo.removeItem(workId);
  await afterQueueChange();
  return c.json({ removed: true });
});

// DELETE /:workId — 出队并删除作品（二次确认由前端做）
queueRoutes.delete("/:workId", async (c) => {
  const workId = c.req.param("workId");
  queueRepo.removeItem(workId);
  const deleted = await deleteWork(workId);
  if (!deleted) return c.json({ error: "Work not found" }, 404);
  await afterQueueChange();
  return c.json({ deleted: true });
});

export default queueRoutes;
