import { getDb } from "./connection.js";

export type QueueStatus = "queued" | "running" | "paused" | "done" | "failed";
export interface QueueItem {
  workId: string; position: number; status: QueueStatus;
  enqueuedAt: string; startedAt: string | null; finishedAt: string | null; resumeAttempts: number;
}

function rowToItem(r: any): QueueItem {
  return { workId: r.work_id, position: r.position, status: r.status,
    enqueuedAt: r.enqueued_at, startedAt: r.started_at, finishedAt: r.finished_at, resumeAttempts: r.resume_attempts };
}

export function enqueue(workId: string, opts: { afterRunning?: boolean } = {}): QueueItem {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM work_queue WHERE work_id = ?").get(workId) as any;
  if (existing) {
    // 已存在：若是终态（done/failed/移除后再入队）则重置为 queued，并分配新的队尾 position
    if (["done", "failed"].includes(existing.status)) {
      const tail = (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
      db.prepare("UPDATE work_queue SET status='queued', position=?, started_at=NULL, finished_at=NULL, resume_attempts=0 WHERE work_id=?").run(tail, workId);
    }
    return rowToItem(db.prepare("SELECT * FROM work_queue WHERE work_id = ?").get(workId));
  }
  let position: number;
  if (opts.afterRunning) {
    const running = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='running'").get() as any;
    const minQueued = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='queued'").get() as any;
    position = running?.p != null && minQueued?.p != null ? (running.p + minQueued.p) / 2
      : (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
  } else {
    position = (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
  }
  db.prepare("INSERT INTO work_queue (work_id, position, status, enqueued_at) VALUES (?,?,?,?)")
    .run(workId, position, "queued", new Date().toISOString());
  return rowToItem(db.prepare("SELECT * FROM work_queue WHERE work_id = ?").get(workId));
}

export function dequeueNext(): QueueItem | undefined {
  const r = getDb().prepare("SELECT * FROM work_queue WHERE status='queued' ORDER BY position LIMIT 1").get() as any;
  return r ? rowToItem(r) : undefined;
}

export function listQueue(): QueueItem[] {
  return (getDb().prepare("SELECT * FROM work_queue ORDER BY position").all() as any[]).map(rowToItem);
}

export function getItem(workId: string): QueueItem | undefined {
  const r = getDb().prepare("SELECT * FROM work_queue WHERE work_id=?").get(workId) as any;
  return r ? rowToItem(r) : undefined;
}

export function setStatus(workId: string, status: QueueStatus): void {
  const db = getDb();
  const extra = status === "running" ? ", started_at=datetime('now')" : ["done","failed"].includes(status) ? ", finished_at=datetime('now')" : "";
  db.prepare(`UPDATE work_queue SET status=?${extra} WHERE work_id=?`).run(status, workId);
}

export function prioritize(workId: string): void {
  const db = getDb();
  const running = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='running'").get() as any;
  const firstQueued = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='queued'").get() as any;
  let newPos: number;
  if (running?.p != null && firstQueued?.p != null) newPos = (running.p + firstQueued.p) / 2;
  else if (firstQueued?.p != null) newPos = firstQueued.p - 1;
  else newPos = (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
  db.prepare("UPDATE work_queue SET position=?, status='queued' WHERE work_id=?").run(newPos, workId);
}

export function incrementResumeAttempts(workId: string): number {
  getDb().prepare("UPDATE work_queue SET resume_attempts=resume_attempts+1 WHERE work_id=?").run(workId);
  return (getItem(workId)?.resumeAttempts ?? 0);
}

export function removeItem(workId: string): void {
  getDb().prepare("DELETE FROM work_queue WHERE work_id=?").run(workId);
}
