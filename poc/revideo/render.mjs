import { renderVideo } from "@revideo/renderer";

const out = await renderVideo({
  projectFile: "/src/project.ts",
  settings: {
    outFile: "structure-demo.mp4",
    outDir: "./out",
    logProgress: true,
    workers: 1,
    // 跳过 puppeteer 自带 Chrome 下载,直接用系统 Edge(Chromium 内核)
    puppeteer: {
      executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
    },
    projectSettings: {
      size: { x: 1080, y: 1920 },
      exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } },
    },
  },
});
console.log("RENDERED:", out);
