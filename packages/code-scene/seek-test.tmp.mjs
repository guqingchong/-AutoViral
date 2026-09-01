import { chromium } from "playwright";
import { existsSync } from "node:fs";
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await chromium.launch({ executablePath: edge });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.addInitScript(() => {
  window.__PARAMS__ = { kicker:"投资金句", title:"慢即是快",
    quote:"投资最重要的不是智商，而是纪律；不是预测风雨，而是建造方舟。慢，即是快；少，即是多。",
    source:"巴菲特致股东信", duration: 8 };
  window.__THEME_CSS__ = ":root{--bg:#0f1b2d;--bg-grid:rgba(148,163,184,.05);--accent:#3b82f6;--accent-2:#60a5fa;--text:#f1f5f9;--text-sub:#94a3b8;--ease-out:cubic-bezier(0.16,1,0.3,1);--font-display:'Microsoft YaHei',sans-serif;}";
});
await page.goto("file:///D:/Autoviral/packages/code-scene/templates-web/quote-card.html");
await page.evaluate(() => document.fonts.ready);
for (const t of [1000, 4667, 7500]) {
  const info = await page.evaluate((tt) => {
    const anims = document.getAnimations({ subtree: true });
    anims.forEach((a) => { a.pause(); a.currentTime = tt; });
    window.__seek?.(tt / 1000);
    return anims.map(a => ({ ct: a.currentTime, ps: a.playState, dl: a.effect.getTiming().delay }));
  }, t);
  await page.screenshot({ path: `/tmp/seek-${t}.png` });
  console.log(t, JSON.stringify(info.slice(0, 6)));
}
await browser.close();
