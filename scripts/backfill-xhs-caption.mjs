// 一次性:为 3 个存量子作品补 cards/caption.txt(小红书配文)
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { generateXhsCaption } from "../dist/services/dual-output.js";
import Database from "better-sqlite3";

const db = new Database(join(homedir(), ".autoviral", "autoviral.db"), { readonly: true });
const CHILDREN = ["w_20260807_1441_b8b", "w_20260807_1441_384", "w_20260807_1441_0d6"];

for (const id of CHILDREN) {
  const art = db.prepare("SELECT title, content FROM articles WHERE work_id = ? ORDER BY created_at DESC LIMIT 1").get(id);
  if (!art) { console.log(id, "无文章,跳过"); continue; }
  const caption = await generateXhsCaption({ title: art.title, content: art.content });
  const p = join(homedir(), ".autoviral", "works", id, "output", "cards", "caption.txt");
  await writeFile(p, caption, "utf-8");
  console.log(id, `caption ${caption.length} 字 →`, JSON.stringify(caption.slice(0, 60)) + "…");
}
