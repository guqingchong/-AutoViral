import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { renderVideo } from "@revideo/renderer";

// 用法: node worker.mjs <jobSpec.json>
// jobSpec: { jobId, scene, params, duration, width, height, outFile, outDir, customCode? }
const specPath = process.argv[2];
if (!specPath) { console.error("usage: node worker.mjs <jobSpec.json>"); process.exit(2); }

const spec = JSON.parse(await readFile(specPath, "utf-8"));
const jobId = spec.jobId ?? `job_${Date.now()}`;
const duration = Math.min(Math.max(spec.duration ?? 6, 1), 30);
const W = spec.width ?? 1080, H = spec.height ?? 1920;

if (spec.scene === "custom") {
  if (!spec.customCode) { console.error(JSON.stringify({ ok: false, error: "custom scene requires customCode" })); process.exit(1); }
  await mkdir("src/custom", { recursive: true });
  await writeFile("src/custom/current.tsx", spec.customCode, "utf-8");
}

// 每任务生成独立 project 文件:size/range/参数全部内联为字面量(避免 bundle 内读 env 的不确定性)
const sceneExpr = spec.scene === "custom"
  ? "customScene"
  : `getSceneFactory(${JSON.stringify(spec.scene)})(${JSON.stringify(spec.params ?? {})})`;
const projectSrc = `
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";
${spec.scene === "custom" ? `import customScene from "../custom/current";` : ""}
const scene = ${sceneExpr};
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(${W}, ${H}), range: [0, ${duration}] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
`;
await mkdir("src/generated", { recursive: true });
const projectFile = `src/generated/project-${jobId}.ts`;
await writeFile(projectFile, projectSrc, "utf-8");

const edgeCandidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const edge = edgeCandidates.find(existsSync);

try {
  const out = await renderVideo({
    projectFile: `/${projectFile}`,
    settings: {
      outFile: spec.outFile ?? `${jobId}.mp4`,
      outDir: spec.outDir ?? "./out",
      logProgress: false,
      workers: 1,
      puppeteer: edge ? { executablePath: edge, headless: true } : undefined,
      projectSettings: {
        size: { x: W, y: H },
        exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } },
      },
    },
  });
  console.log(JSON.stringify({ ok: true, out }));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exit(1);
} finally {
  // 每任务的 generated project 文件是一次性产物,渲染结束(成败)即清理(工程债 C2,2026-08-17)
  await rm(projectFile, { force: true }).catch(() => {});
}
