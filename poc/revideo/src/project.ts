import { makeProject, Vector2 } from "@revideo/core";
import scene from "./scene";

export default makeProject({
  scenes: [scene],
  settings: {
    shared: {
      size: new Vector2(1080, 1920),
      // 显式给定时长窗口,绕过无 exporter 时的时长探测路径
      range: [0, 6],
    },
    rendering: {
      exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } },
    },
  },
});
