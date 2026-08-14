import { createServer } from "vite";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const revideoPlugin = require("@revideo/vite-plugin").default;
const { rendererPlugin } = require("@revideo/renderer/lib/server/renderer-plugin.js");

const server = await createServer({
  configFile: false,
  plugins: [
    revideoPlugin({ project: path.resolve("./src/project.ts"), output: "./out" }),
    rendererPlugin({ size: { x: 1080, y: 1920 }, exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } }, undefined, undefined, "/src/project.ts"),
  ],
  server: { port: 9010, hmr: false },
});
await server.listen();

// 先拉取编译产物检查是否有 transform 错误
for (const u of ["/src/project.ts", "/src/scene.tsx"]) {
  const r = await fetch(`http://localhost:9010${u}`);
  const text = await r.text();
  console.log(`--- ${u} → ${r.status} (${text.length}B)`);
  if (r.status !== 200 || text.length < 200) console.log(text.slice(0, 600));
}

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.exposeFunction("onRenderFailed", (msg) => console.log("[RENDER FAILED]", msg));
await page.exposeFunction("onRenderComplete", () => console.log("[RENDER COMPLETE]"));
await page.exposeFunction("onProgress", () => {});
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 500)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));
await page.goto("http://localhost:9010/render?fileName=debug&workerId=0&totalNumOfWorkers=1&hiddenFolderId=x", { timeout: 30000 });
await page.waitForTimeout(8000);
await browser.close();
await server.close();
