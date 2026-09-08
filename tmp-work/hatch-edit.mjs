// 手工改造 tpl_code_6475acf6（DEEP SPACE）：
// 1) 封面底板 → 太空飞船舱门（大圆环+铆钉阵列+门缝+中心舷窗星空）
// 2) 正文底板 → 飞船操作台（梯形台体+三块屏幕+按钮行+弧形仪表）
// 3) 主视觉卡片左右边距 0 → 48px（用户第 7 条）
// 纯 SVG/CSS 几何、无外链、无定时器/rAF——符合模板硬性契约。

import { readFileSync, writeFileSync } from "node:fs";

const SRC = "D:/Autoviral/tmp-work/tpl_deepspace.html";
const OUT = "D:/Autoviral/tmp-work/tpl_deepspace_v2.html";
let html = readFileSync(SRC, "utf-8");

// ---- 舱门 SVG（封面，viewBox 1080x1920，圆心 540,864） ----
const rivets = [];
for (let k = 0; k < 16; k++) {
  const a = (k * 22.5 * Math.PI) / 180;
  const x = (540 + 494 * Math.cos(a)).toFixed(1);
  const y = (864 + 494 * Math.sin(a)).toFixed(1);
  rivets.push(`<circle cx='${x}' cy='${y}' r='10' fill='#0e151b' stroke='#5a6c78' stroke-width='2'/>`);
}
const hatchSvg = [
  `<svg class='hatch-svg' viewBox='0 0 1080 1920'>`,
  `<defs>`,
  `<radialGradient id='hatchMetal' cx='38%' cy='32%' r='75%'><stop offset='0%' stop-color='#42525e'/><stop offset='45%' stop-color='#222e39'/><stop offset='100%' stop-color='#0b1116'/></radialGradient>`,
  `<linearGradient id='hatchRing' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#5a6c78'/><stop offset='50%' stop-color='#2a3742'/><stop offset='100%' stop-color='#141d24'/></linearGradient>`,
  `<radialGradient id='portSpace' cx='50%' cy='42%' r='65%'><stop offset='0%' stop-color='#0d2436'/><stop offset='70%' stop-color='#071019'/><stop offset='100%' stop-color='#04080d'/></radialGradient>`,
  `</defs>`,
  // 外圈环体 + 高光描边
  `<circle cx='540' cy='864' r='520' fill='url(#hatchRing)'/>`,
  `<circle cx='540' cy='864' r='520' fill='none' stroke='#6e8290' stroke-width='3' opacity='.6'/>`,
  `<circle cx='540' cy='864' r='520' fill='none' stroke='#00d2ff' stroke-width='2' opacity='.18'/>`,
  // 环体与门板间的凹槽
  `<circle cx='540' cy='864' r='468' fill='none' stroke='#0a0f14' stroke-width='10'/>`,
  // 门板
  `<circle cx='540' cy='864' r='440' fill='url(#hatchMetal)' stroke='#374754' stroke-width='4'/>`,
  // 门板横缝（对开门缝）
  `<line x1='100' y1='864' x2='980' y2='864' stroke='#0a0f14' stroke-width='6' opacity='.55'/>`,
  `<line x1='100' y1='861' x2='980' y2='861' stroke='#5a6c78' stroke-width='1.5' opacity='.5'/>`,
  // 铆钉阵列
  ...rivets,
  // 中心舷窗：外框 + 太空景 + 星点
  `<circle cx='540' cy='864' r='170' fill='url(#portSpace)' stroke='#0a0f14' stroke-width='14'/>`,
  `<circle cx='540' cy='864' r='170' fill='none' stroke='#546a78' stroke-width='4'/>`,
  `<circle cx='540' cy='864' r='180' fill='none' stroke='#00d2ff' stroke-width='2' opacity='.35'/>`,
  `<g fill='#cfeef7'>`,
  `<circle cx='500' cy='810' r='3'/><circle cx='585' cy='790' r='2'/><circle cx='612' cy='880' r='2.5'/>`,
  `<circle cx='478' cy='905' r='2'/><circle cx='545' cy='932' r='3'/><circle cx='575' cy='850' r='1.6'/>`,
  `<circle cx='520' cy='860' r='1.8'/><circle cx='600' cy='915' r='1.4'/>`,
  `</g>`,
  `</svg>`,
].join("");

// ---- 操作台 SVG（正文，底部梯形台体 + 屏幕 + 按钮 + 仪表） ----
const screen = (x) => [
  `<rect x='${x}' y='1708' width='200' height='112' rx='8' fill='url(#scrGlow)' stroke='#00d2ff' stroke-opacity='.5' stroke-width='2'/>`,
  `<line x1='${x}' y1='1744' x2='${x + 200}' y2='1744' stroke='#00d2ff' stroke-opacity='.35' stroke-width='2'/>`,
  `<line x1='${x}' y1='1780' x2='${x + 200}' y2='1780' stroke='#00d2ff' stroke-opacity='.2' stroke-width='2'/>`,
  `<circle cx='${x + 20}' cy='1726' r='4' fill='#00d2ff' opacity='.7'/>`,
].join("");
const buttons = [];
for (let i = 0; i < 8; i++) {
  buttons.push(`<circle cx='${190 + i * 100}' cy='1872' r='9' fill='${i % 3 === 0 ? "#00d2ff" : "#22303a"}' stroke='#546a78' stroke-width='2'${i % 3 === 0 ? " opacity='.85'" : ""}/>`);
}
const consoleSvg = [
  `<svg class='console-svg' viewBox='0 0 1080 1920'>`,
  `<defs>`,
  `<linearGradient id='deckMetal' x1='0' y1='0' x2='0' y2='1'><stop offset='0%' stop-color='#2c3a46'/><stop offset='100%' stop-color='#0d141a'/></linearGradient>`,
  `<linearGradient id='scrGlow' x1='0' y1='0' x2='0' y2='1'><stop offset='0%' stop-color='#06232e'/><stop offset='100%' stop-color='#031418'/></linearGradient>`,
  `</defs>`,
  // 台体（梯形：顶边内收）
  `<polygon points='60,1620 1020,1620 1080,1920 0,1920' fill='url(#deckMetal)' stroke='#3d4f5c' stroke-width='3'/>`,
  // 台面沿（扶手条）
  `<polygon points='60,1620 1020,1620 1034,1692 46,1692' fill='#16222b' stroke='#3d4f5c' stroke-width='2'/>`,
  // 台面上的两块弧形仪表（斜面）
  `<path d='M 300 1660 A 62 62 0 0 1 424 1660' fill='none' stroke='#8a9ba8' stroke-width='4'/>`,
  `<line x1='362' y1='1660' x2='398' y2='1624' stroke='#00d2ff' stroke-width='4'/>`,
  `<circle cx='362' cy='1660' r='6' fill='#8a9ba8'/>`,
  `<path d='M 656 1660 A 62 62 0 0 1 780 1660' fill='none' stroke='#8a9ba8' stroke-width='4'/>`,
  `<line x1='718' y1='1660' x2='690' y2='1622' stroke='#00d2ff' stroke-width='4'/>`,
  `<circle cx='718' cy='1660' r='6' fill='#8a9ba8'/>`,
  // 台体正面三块屏幕
  screen(150), screen(440), screen(730),
  // 按钮行
  ...buttons,
  `</svg>`,
].join("");

// ---- 应用改写 ----
// E1. CSS 追加：SVG 定位 + 隐藏原弱圆形装饰（bg-cover::after 与舱门同位会叠影）
const cssAdd = ".hatch-svg,.console-svg{position:absolute;inset:0;width:100%;height:100%}.bg-cover::after{content:none!important}";
html = html.replace("</style></head>", cssAdd + "</style></head>");

// E2. 主视觉卡片左右留边（顶到屏幕两边 → 各留 48px）
html = html.replace(".main-frame{position:absolute;left:0;right:0;", ".main-frame{position:absolute;left:48px;right:48px;");

// E3. 封面插入舱门
html = html.replace("<div class='bg-cover'></div>", `<div class='bg-cover'>${hatchSvg}</div>`);

// E4. 正文插入操作台
html = html.replace(
  "<div class='bg-content'><div class='console'></div></div>",
  `<div class='bg-content'>${consoleSvg}<div class='console'></div></div>`,
);

// 校验四处都命中
const checks = {
  css: html.includes(".hatch-svg"),
  margin: html.includes(".main-frame{position:absolute;left:48px"),
  hatch: html.includes("hatchMetal"),
  console: html.includes("deckMetal"),
};
console.log("改写命中:", JSON.stringify(checks), "新长度:", html.length);
if (!Object.values(checks).every(Boolean)) { console.error("有未命中,中止"); process.exit(1); }
writeFileSync(OUT, html, "utf-8");
console.log("已写出:", OUT);
