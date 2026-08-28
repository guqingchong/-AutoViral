
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("keynote-leather")({"title":"城市更新,正在被 AI 重写","kicker":"URBAN RENEWAL · AI KEYNOTE","subtitleCn":"AI 不是替代规划师,而是让每一平方米都被精确计算","subtitleEn":"AI doesn't replace planners — it computes every square meter.","videoSrc":"C:/tmp/autoviral-scenes/dh-sample.mp4","duration":5});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1920, 1080), range: [0, 5] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
