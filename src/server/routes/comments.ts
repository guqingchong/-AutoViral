import { Hono } from "hono";
import {
  getComments,
  suggestReply,
  postReply,
  batchClassifySentiment,
} from "../../services/comment-service.js";
import { listComments } from "../../db/comments-repo.js";
import { getConfig } from "../../config.js";

const commentsRoutes = new Hono();

commentsRoutes.get("/", (c) => {
  const query = c.req.query();
  const comments = getComments({
    publishRecordId: query.publishRecordId ? Number(query.publishRecordId) : undefined,
    sentiment: query.sentiment as any,
    replied: query.replied === "true" ? true : query.replied === "false" ? false : undefined,
    keyword: query.keyword || undefined,
    limit: query.limit ? Number(query.limit) : 100,
  });
  return c.json(comments);
});

commentsRoutes.post("/:id/reply-suggest", async (c) => {
  const id = Number(c.req.param("id"));
  const comment = listComments({ limit: 10000 }).find((x) => x.id === id);
  if (!comment) return c.json({ error: "not found" }, 404);
  const suggestion = await suggestReply(comment);
  return c.json(suggestion);
});

commentsRoutes.post("/:id/reply", async (c) => {
  const id = Number(c.req.param("id"));
  const { content } = await c.req.json();
  if (!content || typeof content !== "string") return c.json({ error: "content required" }, 400);
  const ok = await postReply(id, content, getConfig().analytics.sources);
  return c.json({ ok });
});

commentsRoutes.post("/classify", (c) => {
  const n = batchClassifySentiment();
  return c.json({ classified: n });
});

export { commentsRoutes };
