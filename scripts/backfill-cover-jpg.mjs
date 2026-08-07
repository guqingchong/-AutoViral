// 一次性:为 3 个存量子作品补 output/cover.jpg(公众号草稿封面,JPEG)
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { chromium } from "playwright";

const CHILDREN = ["w_20260807_1441_b8b", "w_20260807_1441_384", "w_20260807_1441_0d6"];
const worksRoot = join(homedir(), ".autoviral", "works");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
for (const id of CHILDREN) {
  const pngPath = join(worksRoot, id, "output", "cards", "01-cover.png");
  const jpgPath = join(worksRoot, id, "output", "cover.jpg");
  try { await access(jpgPath); console.log(id, "cover.jpg 已存在,跳过"); continue; } catch {}
  const b64 = (await readFile(pngPath)).toString("base64");
  const jpgB64 = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
  }, b64);
  await writeFile(jpgPath, Buffer.from(jpgB64, "base64"));
  console.log(id, "cover.jpg 已生成");
}
await browser.close();
