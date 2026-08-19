import { getDb } from "./connection.js";

export type QueueStatus = "queued" | "running" | "paused" | "done" | "failed";
/** 暂停原因:quota=LLM 配额冷却, budget=日预算熔断, user=用户手动暂停(2026-08-19 v27) */
export type PausedReason = "quota" | "budget" | "user";
export interface QueueItem {
  workId: string; position: number; status: QueueStatus;
  enqueuedAt: string; startedAt: string | null; finishedAt: string | null; resumeAttempts: number;
  pausedReason: string | null;
}

function rowToItem(r: any): QueueItem {
  return { workId: r.work_id, position: r.position, status: r.status,
    enqueuedAt: r.enqueued_at, startedAt: r.started_at, finishedAt: r.finished_at, resumeAttempts: r.resume_attempts,
    pausedReason: r.paused_reason ?? null };
}

/** 队尾 position */
function tailPosition(db: ReturnType<typeof getDb>): number {
  return (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
}

/**
 * afterRunning position：插在 running 之后、其余 queued 之前（取二者中点）。
 * 无 running 或无 queued 时退化为队尾。
 */
function afterRunningPosition(db: ReturnType<typeof getDb>): number {
  const running = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='running'").get() as any;
  const minQueued = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='queued'").get() as any;
  return running?.p != null && minQueued?.p != null ? (running.p + minQueued.p) / 2 : tailPosition(db);
}

export function enqueue(workId: string, opts: { afterRunning?: boolean } = {}): QueueItem {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM work_queue WHERE work_id = ?").get(workId) as any;
  if (existing) {
    // 已存在：若是终态（done/failed/移除后再入队）则重置为 queued。
    // position 同样尊重 opts.afterRunning —— 真实打回流程（入队→执行→settle done
    // →人工打回）必走此分支，打回重做应排在 running 之后第一位而非队尾。
    if (["done", "failed"].includes(existing.status)) {
      const position = opts.afterRunning ? afterRunningPosition(db) : tailPosition(db);
      db.prepare("UPDATE work_queue SET status='queued', paused_reason=NULL, position=?, started_at=NULL, finished_at=NULL, resume_attempts=0 WHERE work_id=?").run(position, workId);
    }
    return rowToItem(db.prepare("SELECT * FROM work_queue WHERE work_id = ?").get(workId));
  }
  const position = opts.afterRunning ? afterRunningPosition(db) : tailPosition(db);
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

export function setStatus(workId: string, status: QueueStatus, opts: { pausedReason?: PausedReason } = {}): void {
  const db = getDb();
  const extra = status === "running" ? ", started_at=datetime('now')" : ["done","failed"].includes(status) ? ", finished_at=datetime('now')" : "";
  // paused 记录原因(默认 user,兼容旧调用);离开 paused 时清空——配额/熔断恢复
  // 只回捞对应原因的项,用户手动暂停的绝不被系统误恢复(2026-08-19 P0)
  const reason = status === "paused" ? (opts.pausedReason ?? "user") : null;
  db.prepare(`UPDATE work_queue SET status=?, paused_reason=?${extra} WHERE work_id=?`).run(status, reason, workId);
}

/** 批量恢复:把指定原因的 paused 项改回 queued(配额解除/预算日切时调用),返回恢复条数 */
export function resumePausedByReason(reasons: PausedReason[]): number {
  if (!reasons.length) return 0;
  const ph = reasons.map(() => "?").join(",");
  const r = getDb().prepare(`UPDATE work_queue SET status='queued', paused_reason=NULL WHERE status='paused' AND paused_reason IN (${ph})`).run(...reasons);
  return r.changes;
}

export function prioritize(workId: string): void {
  const db = getDb();
  const running = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='running'").get() as any;
  const firstQueued = db.prepare("SELECT MIN(position) as p FROM work_queue WHERE status='queued'").get() as any;
  let newPos: number;
  if (running?.p != null && firstQueued?.p != null) newPos = (running.p + firstQueued.p) / 2;
  else if (firstQueued?.p != null) newPos = firstQueued.p - 1;
  else newPos = (db.prepare("SELECT COALESCE(MAX(position),0)+1 as p FROM work_queue").get() as any).p;
  db.prepare("UPDATE work_queue SET position=?, status='queued', paused_reason=NULL WHERE work_id=?").run(newPos, workId);
}

export function incrementResumeAttempts(workId: string): number {
  getDb().prepare("UPDATE work_queue SET resume_attempts=resume_attempts+1 WHERE work_id=?").run(workId);
  return (getItem(workId)?.resumeAttempts ?? 0);
}

/** 进展即清零(2026-08-19 P1):作品每次 pipeline advance 都是存活进展证据,
 *  恢复次数只应统计"连续无进展的死亡恢复",此前成功后永不重置,
 *  长跑作品累计 5 次瞬态失败就被误杀 */
export function resetResumeAttempts(workId: string): void {
  getDb().prepare("UPDATE work_queue SET resume_attempts=0 WHERE work_id=?").run(workId);
}

export function removeItem(workId: string): void {
  getDb().prepare("DELETE FROM work_queue WHERE work_id=?").run(workId);
}
