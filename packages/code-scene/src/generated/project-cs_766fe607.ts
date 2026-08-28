
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("keynote-leather")({"title":"代码模板端到端验证","kicker":"KEYNOTE","subtitleCn":"端到端中文字幕","subtitleEn":"E2E ENGLISH SUB","videoSrc":"/staged/cs_766fe607.mp4","duration":13,"videoRatio":0.5625});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1920, 1080), range: [0, 13] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
