// 视频号发表页诊断:观察 frames/input 随时间的变化
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "channels");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  userAgent: UA,
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.goto("https://channels.weixin.qq.com/platform/post/create", { waitUntil: "domcontentloaded", timeout: 60000 });

for (let t = 0; t < 30; t++) {
  const frames = page.frames();
  const info = [];
  for (const f of frames) {
    const detached = f.isDetached();
    let inputCount = -1, url = "";
    try { url = f.url(); } catch { url = "<err>"; }
    if (!detached) {
      inputCount = await f.evaluate(() => document.querySelectorAll('input[type="file"]').length).catch(() => -2);
    }
    info.push(`[${detached ? "DET" : "ok"} inputs=${inputCount} ${url.slice(0, 80)}]`);
  }
  console.log(`t=${t * 2}s frames=${frames.length} ${info.join(" ")}`);
  await page.waitForTimeout(2000);
}
await context.close();
