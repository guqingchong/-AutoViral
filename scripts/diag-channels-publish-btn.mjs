// 视频号发表按钮诊断:上传→填表→转储按钮→点发表→观察跳转/弹窗
// 注意:这会真实发表该视频(用户目标就是发布它)
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "channels");
const video = join(homedir(), ".autoviral", "works", "w_20260806_1243_5dd", "output", "final.mp4");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UPLOAD = "https://channels.weixin.qq.com/platform/post/create";

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(UPLOAD, { waitUntil: "domcontentloaded", timeout: 60000 });

// 等微前端 frame + input
let frame = null;
for (let i = 0; i < 60 && !frame; i++) {
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    const n = await f.evaluate(() => document.querySelectorAll('input[type="file"]').length).catch(() => 0);
    if (n > 0) { frame = f; break; }
  }
  if (!frame) await page.waitForTimeout(2000);
}
console.log("frame:", frame ? frame.url().slice(0, 60) : "未找到");
if (!frame) { await context.close(); process.exit(1); }

// JS 注入上传
const buf = await readFile(video);
const b64 = buf.toString("base64");
await frame.evaluate(() => { window.__up = []; });
const CHUNK = 8 * 1024 * 1024;
for (let off = 0; off < b64.length; off += CHUNK) {
  await frame.evaluate((p) => { window.__up.push(p); }, b64.slice(off, off + CHUNK));
}
const inj = await frame.evaluate(() => {
  const b64 = window.__up.join(""); delete window.__up;
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], "final.mp4", { type: "video/mp4" });
  const input = document.querySelector('input[type="file"]');
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
});
console.log("注入:", inj);

// 等上传完成(封面预览出现)
for (let t = 0; t < 40; t++) {
  await page.waitForTimeout(3000);
  const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (/封面预览|删除/.test(text)) { console.log(`上传完成 t=${(t + 1) * 3}s`); break; }
}

// 填描述
await frame.evaluate(() => {
  const box = document.querySelector('textarea[placeholder*="描述"], [data-placeholder*="描述"], div[contenteditable="true"]');
  if (box) {
    box.focus();
    if (box instanceof HTMLTextAreaElement) box.value = "城投变产投：产业投资为何成为2026年城投转型第一风口";
    else box.innerText = "城投变产投：产业投资为何成为2026年城投转型第一风口";
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

// 转储全部 frame 的全部按钮
const dumpButtons = async (label) => {
  console.log(`--- ${label} ---`);
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    const btns = await f.evaluate(() =>
      Array.from(document.querySelectorAll("button, [role='button'], [class*='btn']"))
        .map((b) => ({ t: (b.textContent ?? "").trim().slice(0, 14), disabled: b.disabled ?? null, cls: (b.className ?? "").toString().slice(0, 40) }))
        .filter((b) => b.t)
        .slice(0, 20)
    ).catch(() => []);
    console.log(`[${f.url().slice(38, 62)}]`, JSON.stringify(btns));
  }
};
await dumpButtons("发表前按钮");

// 点发表
const click1 = await frame.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button, [role='button']"));
  const b = btns.find((x) => (x.textContent ?? "").trim() === "发表") ?? btns.find((x) => (x.textContent ?? "").includes("发表"));
  if (b) { b.click(); return `clicked: ${b.textContent.trim()} disabled=${b.disabled}`; }
  return "no-btn";
});
console.log("发表点击:", click1);
await page.waitForTimeout(3000);
await dumpButtons("点击后按钮(找确认弹窗)");
await page.screenshot({ path: "scripts/diag-channels-after-publish-click.png" });

// 点确认(如有,全 frame 找)
for (const f of page.frames()) {
  if (f.isDetached()) continue;
  const c = await f.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, [role='button']"));
    const b = btns.find((x) => /确定|确认|发表/.test(x.textContent ?? "") && !/取消/.test(x.textContent ?? ""));
    if (b) { b.click(); return b.textContent.trim(); }
    return null;
  }).catch(() => null);
  if (c) console.log(`确认点击 [${f.url().slice(38, 50)}]:`, c);
}

// 观察 60s
for (let t = 0; t < 20; t++) {
  await page.waitForTimeout(3000);
  const url = page.url();
  const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (!url.includes("post/create")) { console.log(`✅ 页面跳转: ${url}`); break; }
  if (/发表成功|发布成功|审核中/.test(text)) { console.log("✅ 成功文本出现"); break; }
  if (t === 19) console.log("❌ 60s 无跳转无成功文本, url=", url);
}
await page.screenshot({ path: "scripts/diag-channels-final.png" });
await context.close();
