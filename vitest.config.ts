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
          // 2026-09-07:api.ts 已 6600+ 行,beforeEach 的 resetModules+reimport 在高负载
          // 机器上超 10s 默认 hookTimeout(CLI 旗标在 projects 模式下不下发)——提到 60s
          hookTimeout: 60_000,
          testTimeout: 30_000,
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
