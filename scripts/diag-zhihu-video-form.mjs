// 探查知乎视频上传后的表单结构(不上传真实视频,只到表单出现为止)
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "zhihu");
const video = join(homedir(), ".autoviral", "works", "w_20260717_1603_4ce", "output", "final.mp4");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto("https://www.zhihu.com/upload-video", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(3000);

// 用 JS 注入方式设文件(知乎是自研上传,先看 setInputFiles 是否可用)
const input = await page.$('input[type="file"]');
console.log("input 找到:", !!input);
try {
  await input.setInputFiles(video);
  console.log("setInputFiles 成功");
} catch (e) {
  console.log("setInputFiles 失败:", e.message.split("\n")[0]);
}

// 等表单渲染(上传 1.5MB 很快)
for (let t = 0; t < 10; t++) {
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  if (/标题|简介|发布|封面/.test(text)) {
    console.log(`t=${(t + 1) * 3}s 表单已出现`);
    break;
  }
}

// 转储表单元素
const form = await page.evaluate(() => {
  const els = [];
  document.querySelectorAll("input, textarea, [contenteditable], button").forEach((e) => {
    const tag = e.tagName.toLowerCase();
    const ph = e.getAttribute("placeholder") ?? "";
    const type = e.getAttribute("type") ?? "";
    const cls = (e.className ?? "").toString().slice(0, 60);
    const text = (e.textContent ?? "").trim().slice(0, 20);
    if (ph || text || type === "file") els.push(`${tag}[type=${type}] ph="${ph}" cls="${cls}" text="${text}"`);
  });
  return els.slice(0, 40);
});
console.log("表单元素:\n" + form.join("\n"));
await page.screenshot({ path: "scripts/diag-zhihu-video-form.png", fullPage: false });
console.log("截图已存 scripts/diag-zhihu-video-form.png, url=", page.url());
await context.close();
