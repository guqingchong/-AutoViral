// 抖音草稿恢复发布 + 发布流程探查(声明弹窗/复选框)
// 注意:会真实发布该草稿视频(用户目标即发布)
import { chromium } from "playwright";
import { join } from "node:path";
import { homedir } from "node:os";

const profileDir = join(homedir(), ".autoviral", "browser-profiles", "douyin");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const context = await chromium.launchPersistentContext(profileDir, { headless: true, userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

// 点"继续编辑"恢复草稿
const resume = page.locator('text=/继续编辑/').first();
if (await resume.isVisible().catch(() => false)) {
  await resume.click();
  console.log("已点继续编辑");
  await page.waitForTimeout(5000);
} else {
  console.log("无草稿提示");
}

// 转储页面状态
const dump = async (label) => {
  const info = await page.evaluate(() => ({
    url: location.href,
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'))
      .filter((d) => d.getClientRects().length > 0)
      .map((d) => (d.textContent ?? "").replace(/\s+/g, " ").slice(0, 120)),
    checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"]')).map((c) => ({
      checked: c.checked,
      label: (c.closest("label")?.textContent ?? c.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
    })),
    buttons: Array.from(document.querySelectorAll("button"))
      .map((b) => (b.textContent ?? "").trim())
      .filter((t) => t && t.length < 12)
      .slice(0, 20),
  }));
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(info, null, 1));
};
await dump("草稿恢复后");

// 检查标题是否已填,没填补填
const titleBox = page.locator('div[contenteditable="true"]').first();
if (await titleBox.isVisible().catch(() => false)) {
  const cur = await titleBox.innerText().catch(() => "");
  if (!cur.trim()) {
    await titleBox.fill("城投变产投：产业投资为何成为2026年城投转型第一风口");
    console.log("已补填标题");
  } else {
    console.log("标题已存在:", cur.slice(0, 30));
  }
}

// 勾选未勾选的声明复选框(原创/AI声明等,平台要求)
const checked = await page.evaluate(() => {
  const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
  const done = [];
  for (const c of boxes) {
    if (!c.checked) {
      const label = (c.closest("label")?.textContent ?? c.parentElement?.textContent ?? "").trim().slice(0, 30);
      c.click();
      done.push(label);
    }
  }
  return done;
});
if (checked.length) console.log("已勾选声明:", JSON.stringify(checked));

// 点发布
await page.locator('button:text-is("发布")').first().click();
console.log("已点发布");
await page.waitForTimeout(3000);
await dump("点发布后");

// 弹窗处理:勾复选框+点确定/发布
for (let round = 0; round < 3; round++) {
  const handled = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]'))
      .filter((d) => d.getClientRects().length > 0);
    if (dialogs.length === 0) return "no-dialog";
    for (const d of dialogs) {
      for (const c of Array.from(d.querySelectorAll('input[type="checkbox"]:not(:checked)'))) c.click();
      const btn = Array.from(d.querySelectorAll("button")).find((b) => /确定|发布|同意|提交/.test(b.textContent ?? "") && !/取消/.test(b.textContent ?? ""));
      if (btn) { btn.click(); return `clicked:${btn.textContent.trim()}`; }
    }
    return "dialog-no-btn";
  });
  console.log(`弹窗处理 round${round}:`, handled);
  if (handled === "no-dialog") break;
  await page.waitForTimeout(3000);
}

// 观察结果 90s
for (let t = 0; t < 30; t++) {
  await page.waitForTimeout(3000);
  const url = page.url();
  if (/content\/manage|content\/post/.test(url)) { console.log(`✅ 跳转: ${url}`); break; }
  const text = await page.evaluate(() => document.body.innerText);
  if (/发布成功|已发布|审核中/.test(text)) { console.log("✅ 成功文本出现"); break; }
  if (t === 29) console.log("❌ 90s 无结果, url=", url);
}
await page.screenshot({ path: "scripts/diag-douyin-final.png" });
await context.close();
