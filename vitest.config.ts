import { defineConfig } from "vitest/config";

// 真实渲染类测试(code-scene 拉起 Edge+ffmpeg 渲染,CPU/内存开销大)与其他文件并行会
// 互相拖超时,单独划入串行项目:单 fork、文件不并行(工程债 C1,2026-08-17)
const RENDER_SERIAL = ["tests/services/code-scene.test.ts"];

export default defineConfig({
  test: {
    root: ".",
    projects: [
      {
        test: {
          name: "default",
          include: ["tests/**/*.test.ts"],
          exclude: RENDER_SERIAL,
        },
      },
      {
        test: {
          name: "render-serial",
          include: RENDER_SERIAL,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
        },
      },
    ],
  },
});
