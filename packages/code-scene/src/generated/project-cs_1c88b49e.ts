
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("quote-card")({"quote":"2026年先模拟后改造成常态","source":"本片判断"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 6] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
