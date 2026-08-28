/**
 * GPU 互斥锁(2026-08-28 批次9.1,H3-5)。
 *
 * H3(ComfyUI 生视频)与 HeyGem(数字人渲染)共用同一台 AutoDL GPU 实例
 * (config.ts 隧道默认值同 host),此前无任何互斥——同时提交即撞车。
 * 本模块提供进程内互斥:一方持有 GPU 时另一方排队等待(带超时)。
 */

let holder: string | null = null;
const queue: Array<{ owner: string; resolve: (release: () => void) => void }> = [];

/** 获取 GPU 锁(带超时,默认 30min 排队上限)。返回 release 函数。 */
export function acquireGpuLock(owner: string, timeoutMs = 30 * 60_000): Promise<() => void> {
  return new Promise((resolvePromise, reject) => {
    const entry = {
      owner,
      resolve: (release: () => void) => {
        clearTimeout(timer);
        resolvePromise(release);
      },
    };
    const timer = setTimeout(() => {
      const idx = queue.indexOf(entry);
      if (idx >= 0) queue.splice(idx, 1);
      reject(new Error(`GPU 锁等待超时(${owner},${Math.round(timeoutMs / 60000)}min):另一子系统长期占用 GPU`));
    }, timeoutMs);

    const tryAcquire = () => {
      if (holder === null && queue[0] === entry) {
        queue.shift();
        holder = owner;
        entry.resolve(() => {
          holder = null;
          queue[0] && tryAcquireNext();
        });
        return true;
      }
      return false;
    };
    const tryAcquireNext = () => {
      const next = queue[0];
      if (!next || holder !== null) return;
      queue.shift();
      holder = next.owner;
      next.resolve(() => {
        holder = null;
        tryAcquireNext();
      });
    };
    queue.push(entry);
    tryAcquire();
  });
}

/** 当前持有者(观测/调试用) */
export function gpuLockHolder(): string | null {
  return holder;
}
