
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("keynote-leather")({"title":"城市更新,正在被 AI 重写","kicker":"URBAN RENEWAL · AI KEYNOTE","subtitleCn":"AI 不是替代规划师,而是让每一平方米都被精确计算","subtitleEn":"AI doesn't replace planners — it computes every square meter.","videoSrc":"C:/Users/顾庆冲/.autoviral/digital-human-jobs/dhjob_02c2c650-f47d-4c1b-b6d9-f0caa9762ac9/output.mp4"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1920, 1080), range: [0, 5] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
