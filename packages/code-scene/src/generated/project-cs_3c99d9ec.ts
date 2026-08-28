
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";
import customScene from "../custom/current";
const scene = customScene;
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 6] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
