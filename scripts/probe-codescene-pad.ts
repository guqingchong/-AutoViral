import { renderCodeScene } from "../src/services/code-scene.js";
import { probeMedia } from "../src/video/ffmpeg.js";
const r = await renderCodeScene({
  workId: "w_code_scene_test", filename: "it-flow2",
  template: { name: "flow-steps", params: { title: "退出三标准", steps: [{ title: "隐债清零" }, { title: "剥离职能" }] } },
  duration: 4, theme: "finance_dark",
});
console.log("result:", JSON.stringify(r));
if (r.path) console.log("final probe:", JSON.stringify(await probeMedia(r.path)));
process.exit(0);
