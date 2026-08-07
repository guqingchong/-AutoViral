// 探查知乎视频发布:描述框/视频标记选择流程/发布前置条件(不点发布)
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

await (await page.$('input[type="file"]')).setInputFiles(video);

// 等标题框出现
await page.locator('textarea[placeholder="标题"]').waitFor({ timeout: 30000 });
console.log("上传已开始,标题框出现");

// 填标题(覆盖默认文件名)
const titleBox = page.locator('textarea[placeholder="标题"]');
await titleBox.click();
await titleBox.fill("河北中考体育50分：过程性考核从初一就开始算？");

// 描述框:占位文本"分享你此刻的想法"
const descInfo = await page.evaluate(() => {
  const cands = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    .filter((e) => e.getAttribute("placeholder") !== "标题");
  return cands.map((e) => `${e.tagName} ce=${e.getAttribute("contenteditable")} ph=${e.getAttribute("placeholder") ?? ""} cls=${(e.className ?? "").toString().slice(0, 50)}`);
});
console.log("描述框候选:", JSON.stringify(descInfo));

// 填描述(用第一个非标题 contenteditable)
const descBox = page.locator('[contenteditable="true"]').first();
if (await descBox.count() > 0) {
  await descBox.click();
  await page.keyboard.type("中考体育过程性考核占了20分，从初一就开始累计，初三再突击真的来得及吗？", { delay: 5 });
  console.log("描述已填");
}

// 等上传完成(封面可选取代"视频上传中"/进度条消失)
for (let t = 0; t < 20; t++) {
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body.innerText);
  if (!/视频上传中/.test(text)) { console.log(`t=${(t + 1) * 3}s 上传完成`); break; }
}

// 视频标记(必填):点"选择标记"看弹层结构
await page.locator('button[aria-label="选择视频标记"]').first().click().catch(async () => {
  await page.locator('button:has-text("选择标记")').first().click({ force: true });
});
await page.waitForTimeout(1500);
const tagPanel = await page.evaluate(() => {
  const cands = Array.from(document.querySelectorAll("input")).filter((i) => /搜索|标记|话题|标签/.test(i.getAttribute("placeholder") ?? ""));
  const btns = Array.from(document.querySelectorAll("button, [role='button'], span, div"))
    .map((e) => (e.textContent ?? "").trim())
    .filter((t) => t && t.length <= 12 && /教育|中考|河北|学习|校园|亲子|成长|育儿/.test(t))
    .slice(0, 15);
  return { searchInputs: cands.map((i) => i.getAttribute("placeholder")), tagCandidates: [...new Set(btns)] };
});
console.log("标记面板:", JSON.stringify(tagPanel, null, 1));
await page.screenshot({ path: "scripts/diag-zhihu-tag-panel.png" });

// 尝试搜索标记"中考"并选中第一个联想
const tagSearch = page.locator('input[placeholder*="搜索"], input[placeholder*="标记"], input[placeholder*="话题"]').last();
if (await tagSearch.count() > 0) {
  await tagSearch.click();
  await tagSearch.fill("中考");
  await page.waitForTimeout(1500);
  const sug = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[class*='option'], [class*='item'], [class*='suggest'], li"))
      .map((e) => (e.textContent ?? "").trim())
      .filter((t) => t && t.length <= 15)
      .slice(0, 10)
  );
  console.log("联想候选:", JSON.stringify(sug));
  await page.screenshot({ path: "scripts/diag-zhihu-tag-suggest.png" });
}

// 发布按钮状态
const submitInfo = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("发布视频"));
  return btn ? { disabled: btn.disabled, cls: btn.className.slice(0, 80) } : null;
});
console.log("发布按钮:", JSON.stringify(submitInfo));

console.log("url=", page.url(), " (未点发布,草稿已存)");
await context.close();
