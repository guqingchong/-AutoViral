
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("quote-card")({"quote":"����������ӪȨ����Ŀ�治��","author":"��������","source":"�������","theme":"finance_dark"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 6] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
