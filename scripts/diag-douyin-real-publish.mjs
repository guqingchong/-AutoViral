// 抖音发布(健壮版):逐步带日志+截图,覆盖 草稿恢复/视频上传/声明/发布/验证
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "douyin");
const video = join(homedir(), ".autoviral", "works", "w_20260806_1243_5dd", "output", "final.mp4");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const shot = (page, name) => page.screenshot({ path: `scripts/diag-dy-${name}.png` });

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);

// 1. 草稿恢复(提示可能在 5-10s 后才出现,轮询等)
let resumed = false;
for (let t = 0; t < 10 && !resumed; t++) {
  resumed = await page.evaluate(() => {
    const el = document.querySelector('span[class*=continue]');
    if (el && el.getClientRects().length > 0) { el.click(); return true; }
    return false;
  });
  if (!resumed) await page.waitForTimeout(2000);
}
console.log("① 草稿恢复:", resumed);
await page.waitForTimeout(8000);
await shot(page, "1-resumed");

// 2. 检查视频是否在;不在则上传
let hasVideo = await page.evaluate(() => /重新上传|更换视频/.test(document.body.innerText));
console.log("② 视频已在位:", hasVideo);
if (!hasVideo) {
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 30000 });
  await fileInput.setInputFiles(video);
  console.log("② 视频已传入,等上传完成…");
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText);
    const uploading = /上传中|处理中|转码中|\d+%/.test(text);
    if (!uploading && /重新上传|更换视频/.test(text)) { hasVideo = true; break; }
    await page.waitForTimeout(4000);
  }
  console.log("② 上传完成:", hasVideo);
}
await shot(page, "2-video");

// 3. 自主声明
const openDeclare = await page.evaluate(() => {
  const sel = Array.from(document.querySelectorAll('[class*=select], [role=combobox], [class*=Select]'))
    .find((e) => /请选择自主声明|自主声明/.test(e.textContent ?? "") && (e.textContent ?? "").length < 30);
  if (sel) { sel.click(); return true; }
  return false;
});
console.log("③ 声明下拉打开:", openDeclare);
await page.waitForTimeout(2000);
const picked = await page.evaluate(() => {
  const dialog = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'))
    .find((d) => /声明类型/.test(d.textContent ?? "") && d.getClientRects().length > 0);
  if (!dialog) return "no-dialog";
  const opt = Array.from(dialog.querySelectorAll("label, span, div"))
    .find((e) => (e.textContent ?? "").trim() === "内容由AI生成");
  if (opt) { opt.click(); return "picked"; }
  return "no-option";
});
console.log("③ 声明选择:", picked);
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const dialog = Array.from(document.querySelectorAll('[class*="modal"], [role="dialog"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]'))
    .find((d) => /声明类型/.test(d.textContent ?? "") && d.getClientRects().length > 0);
  const btn = dialog && Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent.trim() === "确定");
  if (btn) btn.click();
});
await page.waitForTimeout(1500);
console.log("③ 声明生效:", await page.evaluate(() => /内容由AI生成/.test(document.body.innerText)));
await shot(page, "3-declared");

// 4. 发布(按钮可能在页面底部,先滚动)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1000);
const pubBtn = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "发布");
  if (btn) { btn.scrollIntoView(); btn.click(); return true; }
  return false;
});
console.log("④ 发布点击:", pubBtn);
await page.waitForTimeout(4000);
await shot(page, "4-after-publish-click");

// 5. 弹窗处理
for (let round = 0; round < 3; round++) {
  const handled = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'))
      .filter((d) => d.getClientRects().length > 0 && (d.textContent ?? "").trim());
    if (dialogs.length === 0) return "no-dialog";
    for (const d of dialogs) {
      for (const c of Array.from(d.querySelectorAll('input[type="checkbox"]:not(:checked)'))) c.click();
      const btn = Array.from(d.querySelectorAll("button")).find((b) => /确定|发布|同意|提交/.test(b.textContent ?? "") && !/取消/.test(b.textContent ?? ""));
      if (btn) { btn.click(); return `clicked:${btn.textContent.trim()}`; }
    }
    return "dialog-no-btn:" + dialogs.map((d) => (d.textContent ?? "").replace(/\s+/g, " ").slice(0, 60)).join(" | ");
  });
  console.log(`⑤ 弹窗 round${round}:`, handled);
  if (handled === "no-dialog") break;
  await page.waitForTimeout(3000);
}

// 6. 结果观察 90s
let ok = false;
for (let t = 0; t < 30; t++) {
  await page.waitForTimeout(3000);
  const url = page.url();
  if (/content\/manage|content\/post/.test(url)) { ok = true; console.log(`⑥ ✅ 跳转: ${url}`); break; }
  const text = await page.evaluate(() => document.body.innerText);
  if (/发布成功|已发布|审核中/.test(text)) { ok = true; console.log("⑥ ✅ 成功文本"); break; }
}
if (!ok) console.log("⑥ ❌ 90s 无结果, url=", page.url());
await shot(page, "6-final");
await context.close();
