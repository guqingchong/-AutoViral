
import { makeProject, Vector2 } from "@revideo/core";
import { getSceneFactory } from "../scenes";

const scene = getSceneFactory("structure-growth")({"title":"����ծ��Ա�","center":"����ƽ̨","branches":[{"text":"����ծ��","label":"��������"},{"text":"��Ӫ��ծ��","label":"�г��Ե�"}],"theme":"ink_green"});
export default makeProject({
  scenes: [scene],
  settings: {
    shared: { size: new Vector2(1080, 1920), range: [0, 10] },
    rendering: { exporter: { name: "@revideo/core/ffmpeg", options: { format: "mp4" } } },
  },
});
