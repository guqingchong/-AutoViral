// 验证修复:单次 goto(模拟修复后的 doUpload 不重复导航)→ setInputFiles
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "channels");
const video = join(homedir(), ".autoviral", "works", "w_20260717_1603_4ce", "output", "final.mp4");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UPLOAD = "https://channels.weixin.qq.com/platform/post/create";

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

await page.goto(UPLOAD, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("单次 goto 完成:", page.url());

await page.locator("text=/发表动态|视频描述|上传时长/").first().waitFor({ state: "visible", timeout: 45000 }).catch(() => {});

for (let attempt = 0; attempt < 8; attempt++) {
  try {
    const frames = page.frames();
    const desc = [];
    for (const f of frames) {
      const n = f.isDetached() ? -1 : await f.evaluate(() => document.querySelectorAll('input[type="file"]').length).catch(() => -2);
      desc.push(`${f.isDetached() ? "DET" : "ok"}(inputs=${n}):${f.url().slice(38, 65)}`);
    }
    console.log(`attempt ${attempt} frames: ${desc.join(" | ")}`);
    const frame = frames.find((f) => !f.isDetached() && f.url().includes("/micro/"));
    if (!frame) throw new Error("无 /micro/ frame");
    // wujie 沙箱:frame.$ 找不到、evaluateHandle 句柄被 Playwright 判 detached。
    // 终极绕过:把文件内容传进页面,JS 构造 File + DataTransfer 直接赋值并
    // 派发 change,完全不经 Playwright 节点依附检查。
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(video);
    const b64 = buf.toString("base64");
    const CHUNK = 8 * 1024 * 1024;
    // 分块传入,避免单次 evaluate 参数过大
    await frame.evaluate(() => { window.__uploadChunks = []; });
    for (let off = 0; off < b64.length; off += CHUNK) {
      const part = b64.slice(off, off + CHUNK);
      await frame.evaluate((p) => { window.__uploadChunks.push(p); }, part);
    }
    const result = await frame.evaluate(() => {
      const b64 = window.__uploadChunks.join("");
      delete window.__uploadChunks;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "final.mp4", { type: "video/mp4" });
      const input = document.querySelector('input[type="file"]');
      if (!input) return "no-input";
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return `ok files=${input.files.length} size=${input.files[0]?.size}`;
    });
    console.log(`  evaluate 注入结果: ${result}`);
    if (String(result).startsWith("ok")) {
      console.log(`✅ attempt ${attempt}: JS 注入上传成功`);
      break;
    }
    throw new Error(String(result));
    console.log(`✅ attempt ${attempt}: setInputFiles 成功`);
    break;
  } catch (e) {
    console.log(`  失败: ${e.message.split("\n")[0]}`);
    await page.waitForTimeout(3000);
  }
}
await page.waitForTimeout(8000);
await page.screenshot({ path: "scripts/diag-after-set.png" });
console.log("截图已存, url=", page.url());
await context.close();
