import { it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("debug regress 400", async () => {
  const dir = await mkdtemp(join(tmpdir(), "av-regress-dbg-"));
  process.env.AUTOVIRAL_DATA_DIR = dir;
  vi.resetModules();
  const conn = await import("../../src/db/connection.js");
  const { migrate } = await import("../../src/db/migrate.js");
  conn.resetInMemoryDb();
  migrate();
  const api = await import("../../src/server/api.js");
  api.setWsBridge({ getSession: () => undefined, sendMessage: vi.fn(async () => true), broadcastToBrowsers: vi.fn() } as never);
  const { createWork } = await import("../../src/work-store.js");
  const w = await createWork({ title: "dbg", type: "short-video", platforms: ["douyin"] } as never);
  const gapsDir = join(dir, "works", w.id, "assets");
  await mkdir(gapsDir, { recursive: true });
  await writeFile(join(gapsDir, "material-gaps.json"), "{}", "utf-8");
  const res = await api.apiRoutes.request(`/api/works/${w.id}/pipeline/regress`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromStep: "plan-assets", toStep: "content-research" }),
  });
  console.log("status:", res.status, "body:", await res.text());
  await rm(dir, { recursive: true, force: true });
}, 30000);
