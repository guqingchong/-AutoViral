// 探查知乎视频上传入口与页面结构
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "zhihu");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CANDIDATES = [
  "https://www.zhihu.com/creator",
  "https://www.zhihu.com/zvideo/upload-video",
];

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

for (const url of CANDIDATES) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? "");
    const fileInputs = await page.evaluate(() => document.querySelectorAll('input[type="file"]').length);
    console.log(`\n=== ${url} → ${page.url()} ===`);
    console.log(`fileInputs=${fileInputs}`);
    console.log(text.replace(/\n+/g, " | ").slice(0, 400));
    // 找"发布/上传/视频"相关入口链接
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button"))
        .map((e) => ({ t: (e.textContent ?? "").trim(), h: e.getAttribute("href") ?? "" }))
        .filter((x) => /视频|发布|上传|创作/.test(x.t) && x.t.length < 20)
        .slice(0, 15)
    );
    console.log("入口候选:", JSON.stringify(links));
  } catch (e) {
    console.log(`\n=== ${url} 失败: ${e.message.split("\n")[0]}`);
  }
}
await page.screenshot({ path: "scripts/diag-zhihu-creator.png" });
await context.close();
