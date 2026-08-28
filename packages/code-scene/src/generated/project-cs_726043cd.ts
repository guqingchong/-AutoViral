
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("flow-steps")({"title":"退出三标准","steps":[{"title":"隐债清零"},{"title":"剥离职能"}],"theme":"finance_dark"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 4] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
