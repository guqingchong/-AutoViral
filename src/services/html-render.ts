/**
 * 共享无头浏览器渲染服务(2026-08-14 素材来源扩展公共基建)。
 *
 * A1 数据图表 / A2 快照卡 / A3 图标插画 以及后续 HTML 视频渲染共用的
 * HTML→PNG 渲染底座。浏览器单例复用(每次 launch 约 1-2s,批量出图
 * 必须复用),页面对象随用随开随关(渲染间完全隔离,无状态泄漏)。
 *
 * 约定(沿用 dual-output 的踩坑经验):
 * - about:blank 文档加载 file:// 子资源会被 Chromium 拦截,外部资源一律
 *   内联 data URI 或 <script>/<style> 直插;
 * - 截图前等图片加载完成 + document.fonts.ready,防止字体/图片竞态。
 */

import { chromium, type Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

async function getRenderBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) return b;
    browserPromise = null;
  }
  browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

export interface HtmlRenderOptions {
  width: number;
  height: number;
  /** 输出像素放大倍数(高清出图用 2),默认 1 */
  scale?: number;
  /** setContent 后额外等待 ms(留给动画/异步渲染),默认 0 */
  waitMs?: number;
  /** 页面自定义就绪信号:window.__renderReady === true 才截图 */
  waitForReadyFlag?: boolean;
  /** 超时 ms,默认 30000 */
  timeoutMs?: number;
}

/** 渲染 HTML 到 PNG 文件,返回输出路径 */
export async function renderHtmlToPng(html: string, outPath: string, opts: HtmlRenderOptions): Promise<string> {
  const browser = await getRenderBrowser();
  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale ?? 1,
  });
  try {
    await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs ?? 30000 });
    // 图片加载竞态防线
    await page
      .waitForFunction(() => Array.from(document.images).every((i) => i.complete), { timeout: 15000 })
      .catch(() => {});
    // 字体加载竞态防线(中文渲染错字体验极差)
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    if (opts.waitForReadyFlag) {
      await page
        .waitForFunction(() => (window as unknown as { __renderReady?: boolean }).__renderReady === true, { timeout: opts.timeoutMs ?? 30000 })
        .catch(() => {});
    }
    if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
    await page.screenshot({ path: outPath, type: "png" });
    return outPath;
  } finally {
    await page.close();
  }
}

/** 渲染 HTML 返回 PNG Buffer(不落盘场景) */
export async function renderHtmlToBuffer(html: string, opts: HtmlRenderOptions): Promise<Buffer> {
  const browser = await getRenderBrowser();
  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale ?? 1,
  });
  try {
    await page.setContent(html, { waitUntil: "load", timeout: opts.timeoutMs ?? 30000 });
    await page
      .waitForFunction(() => Array.from(document.images).every((i) => i.complete), { timeout: 15000 })
      .catch(() => {});
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    if (opts.waitForReadyFlag) {
      await page
        .waitForFunction(() => (window as unknown as { __renderReady?: boolean }).__renderReady === true, { timeout: opts.timeoutMs ?? 30000 })
        .catch(() => {});
    }
    if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
    return await page.screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

/** 服务关停时调用(测试/进程退出) */
export async function closeRenderBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.isConnected()) await b.close();
    browserPromise = null;
  }
}
